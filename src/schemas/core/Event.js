'use strict';

import Document, { documentSchema as baseDocumentSchema } from '../Document.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/schema/event';
const DOCUMENT_SCHEMA_VERSION = '3.0';

// The three things a time-bound entry can be. Deliberately one entity with a
// subtype rather than three: the founding query is "show me everything happening
// under /work/customer-foo", and a calendar app, an alert panel and an activity
// feed are three lenses on that one set — not three unrelated corpora.
const EVENT_TYPES = ['calendar', 'alert', 'activity'];

// One timeline for all three types; the kind bitmaps discriminate. `events` is
// NOT registered in `pointTimelines` (index.js, Db constructor) because calendar
// entries have duration — and a start-only entry on an interval timeline is
// already stored as an instant, so alerts and activity points cost nothing extra.
// This is what makes "all time-bound docs in this context" a single timeline
// scan, with `data/kind/event/calendar` narrowing it when a caller wants only one.
const EVENTS_TIMELINE = 'events';

const documentDataSchema = Document.extendDataSchema(
    z.object({
        title: z.string(),
        // Required, not defaulted. This drives the kind bitmap, so a silent
        // default would mis-file documents into exactly the query this entity
        // exists to serve.
        type: z.enum(EVENT_TYPES),
        description: z.string().optional(),

        // start is mandatory — an event with no position on the timeline is not
        // an event. `end` omitted => instant; `end: null` => open/ongoing
        // interval (the Timeline index reads an explicit null as unbounded).
        start: z.string().datetime(),
        end: z.string().datetime().nullable().optional(),

        allDay: z.boolean().optional(),
        location: z.string().optional(),

        // RFC 5545 RRULE value (the part after "RRULE:"), e.g.
        // 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T235959Z'. Stored verbatim; a
        // BOUNDED series in the supported subset is expanded into per-occurrence
        // timeline entries, everything else keeps the envelope — see
        // #deriveTimelines. Deliberately not in checksumFields: editing the rule
        // edits the series, it does not create a new event (CalDAV keeps the
        // same UID).
        recurrence: z.string().regex(/FREQ=/i, 'recurrence must be an RFC 5545 RRULE value containing FREQ=').optional(),
    }).passthrough(),
);

// UNTIL is RFC 5545 basic format: YYYYMMDD or YYYYMMDDTHHMMSS(Z).
const RRULE_UNTIL_RE = /(?:^|;)\s*UNTIL=(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?Z?/i;

export default class Event extends Document {

    // Index configuration is SCHEMA-level, resolved by Document from this
    // static. Never stored on the row (see documentSchema).
    static indexOptions = {
        ftsSearchFields: ['data.title', 'data.description', 'data.location'],
        vectorEmbeddingFields: ['data.title', 'data.description'],
        checksumFields: ['data.title', 'data.start', 'data.type'],
    };

    constructor(options = {}) {
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = DOCUMENT_SCHEMA_VERSION;

        options.timelines = Event.#deriveTimelines(options);

        super(options);
    }

    // start/end → 'events' timeline entries, derived (doc declares, index derives).
    // Caller-provided non-events entries are preserved; the events entries are
    // always regenerated from the data so they can never drift from the document.
    //
    // RECURRENCE. Multi-position timelines landed (2026-08-16): one document can
    // occupy N positions on one timeline (primary interval in the sortable BSI,
    // the rest in the tiled membership plane), which unblocked the expansion the
    // envelope model (2026-08-03) deferred. Two regimes, chosen deterministically
    // from the document alone:
    //
    // - BOUNDED series in the supported RRULE subset (see #expandRecurrence):
    //   expanded into per-occurrence entries — first occurrence is the primary
    //   (the series' sortable position), the rest are membership positions. A
    //   weekly standup now answers "what happens this week" only in weeks that
    //   actually contain an occurrence, at the timeline's quantum (day).
    //
    // - Everything else (unbounded rule, unsupported RRULE features, expansion
    //   over the cap): the ENVELOPE — first occurrence to UNTIL, or open when
    //   the rule never ends — and the client expands the RRULE to render real
    //   occurrences, exactly as a CalDAV client does with VEVENT+RRULE. The
    //   envelope is a deliberate SUPERSET (candidate-set-then-refine): it may
    //   over-match, it can never miss an occurrence.
    //
    // Expansion is bounded by the rule (COUNT/UNTIL), never by "now": deriving
    // from wall-clock time would make index content time-dependent and rebuilds
    // drift. Exact occurrence rendering stays the client's job either way.
    static #deriveTimelines(options) {
        const prior = (Array.isArray(options.timelines) ? options.timelines : [])
            .filter((t) => (t?.timeline || t?.name) !== EVENTS_TIMELINE);

        const data = options.data ?? {};
        const start = data.start;
        if (typeof start === 'string' && start.length > 0) {
            const recurrence = data.recurrence;

            if (typeof recurrence === 'string' && recurrence.length > 0) {
                const occurrences = Event.#expandRecurrence(recurrence, data);
                if (occurrences) {
                    prior.push(...occurrences);
                } else {
                    // Envelope fallback. `data.end` still describes ONE
                    // occurrence's duration, so it must not become the envelope
                    // end — the envelope comes from the rule.
                    prior.push({ timeline: EVENTS_TIMELINE, start, end: Event.#recurrenceEnvelopeEnd(recurrence) });
                }
            } else {
                const entry = { timeline: EVENTS_TIMELINE, start };
                if ('end' in data) {
                    // Distinguish "no end" (instant) from an explicit null
                    // (ongoing): omitting the key entirely is what the Timeline
                    // index reads as an instant, so we must not write
                    // `end: undefined`.
                    entry.end = data.end;
                }
                prior.push(entry);
            }
        }

        return prior;
    }

    // Occurrence cap. Not a horizon: rules bounded by COUNT/UNTIL beyond this
    // fall back to the envelope (over-match, never miss) instead of truncating.
    static MAX_RECURRENCE_EXPANSION = 512;

    // UTC weekday index (getUTCDay) per RFC 5545 BYDAY code.
    static #BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

    /**
     * Deterministic expansion of a BOUNDED RRULE into 'events' timeline entries,
     * or null when the rule must keep the envelope. Supported subset — the
     * shapes Google/Teams/CalDAV sync actually emits:
     *   FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL,
     *   BYDAY (WEEKLY only; with INTERVAL>1 only when BYDAY is a single day,
     *   since multi-day biweekly grouping depends on WKST week numbering).
     * Any other RRULE part → null. MONTHLY on day 29-31 SKIPS months lacking
     * the day and YEARLY on Feb 29 skips non-leap years (RFC 5545 invalid-date
     * behavior — the Jan-31-plus-a-month family FeatureBase's addMonth guards).
     *
     * @returns {Array<{timeline, start, end?}>|null} entries, first = primary
     */
    static #expandRecurrence(recurrence, data) {
        const parts = {};
        for (const kv of recurrence.split(';')) {
            const trimmed = kv.trim();
            if (!trimmed) { continue; }
            const eq = trimmed.indexOf('=');
            if (eq < 1) { return null; }
            parts[trimmed.slice(0, eq).toUpperCase()] = trimmed.slice(eq + 1).toUpperCase();
        }

        const SUPPORTED = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST']);
        if (Object.keys(parts).some((k) => !SUPPORTED.has(k))) { return null; }

        const freq = parts.FREQ;
        if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) { return null; }
        const interval = parts.INTERVAL ? parseInt(parts.INTERVAL, 10) : 1;
        if (!Number.isInteger(interval) || interval < 1) { return null; }

        let byday = null;
        if (parts.BYDAY !== undefined) {
            if (freq !== 'WEEKLY') { return null; }
            byday = parts.BYDAY.split(',').map((d) => Event.#BYDAY[d.trim()]);
            if (byday.some((d) => d === undefined)) { return null; }
            if (interval > 1 && byday.length > 1) { return null; }
        }

        const count = parts.COUNT ? parseInt(parts.COUNT, 10) : null;
        if (parts.COUNT && (!Number.isInteger(count) || count < 1)) { return null; }
        let untilMs = null;
        if (parts.UNTIL) {
            const iso = Event.#recurrenceEnvelopeEnd(`UNTIL=${parts.UNTIL}`);
            untilMs = iso ? Date.parse(iso) : NaN;
            if (Number.isNaN(untilMs)) { return null; }
        }
        if (count === null && untilMs === null) { return null; } // unbounded → envelope

        const startMs = Date.parse(data.start);
        if (Number.isNaN(startMs)) { return null; }
        if (data.end === null) { return null; } // ongoing single occurrence + a rule — keep the envelope
        const durationMs = (typeof data.end === 'string' && data.end.length > 0)
            ? Date.parse(data.end) - startMs
            : null;
        if (durationMs !== null && Number.isNaN(durationMs)) { return null; }

        const DAY = 86400000;
        const starts = [];
        const push = (ms) => {
            if (untilMs !== null && ms > untilMs) { return false; }
            if (starts.length >= Event.MAX_RECURRENCE_EXPANSION) { return false; }
            starts.push(ms);
            return count === null || starts.length < count;
        };

        // Plain weekly stepping only covers a single BYDAY that DTSTART already
        // sits on; multiple days, or an off-pattern DTSTART, need the day-scan
        // (both are INTERVAL=1 by the guards above — a biweekly off-pattern
        // start would need WKST week numbering, which is out of subset).
        let weeklyScan = false;
        if (freq === 'WEEKLY' && byday) {
            const startDay = new Date(startMs).getUTCDay();
            weeklyScan = byday.length > 1 || startDay !== byday[0];
            if (weeklyScan && interval > 1) { return null; }
        }

        if (weeklyScan) {
            // DTSTART is always the first occurrence per RFC 5545, even
            // off-pattern.
            let ms = startMs;
            if (!push(ms)) { /* fall through to bounds check */ }
            else {
                const daySet = new Set(byday);
                for (let guard = 0; guard < Event.MAX_RECURRENCE_EXPANSION * 8; guard++) {
                    ms += DAY;
                    if (untilMs !== null && ms > untilMs) { break; }
                    if (!daySet.has(new Date(ms).getUTCDay())) { continue; }
                    if (!push(ms)) { break; }
                }
            }
        } else if (freq === 'DAILY' || freq === 'WEEKLY') {
            const step = interval * DAY * (freq === 'WEEKLY' ? 7 : 1);
            for (let ms = startMs; push(ms); ms += step) { /* push() drives */ }
        } else {
            // MONTHLY / YEARLY: calendar stepping on UTC fields, skipping
            // invalid dates (Jan 31 + 1mo, Feb 29 + 1yr) instead of rolling over.
            const d = new Date(startMs);
            const y0 = d.getUTCFullYear(), mo0 = d.getUTCMonth(), day0 = d.getUTCDate();
            const timeOfDay = startMs - Date.UTC(y0, mo0, day0);
            const monthStep = freq === 'MONTHLY' ? interval : interval * 12;
            let going = true;
            for (let i = 0; going && i < Event.MAX_RECURRENCE_EXPANSION * 8; i++) {
                const monthIndex = mo0 + (i * monthStep);
                const ms = Date.UTC(y0, monthIndex, day0) + timeOfDay;
                if (new Date(ms).getUTCDate() !== day0) { continue; } // rolled over → invalid date, skip
                going = push(ms);
                if (untilMs !== null && ms > untilMs) { break; }
            }
        }

        // Refuse truncation: if the rule wants more occurrences than we emitted,
        // the envelope's never-miss property wins over precision.
        if (count !== null && starts.length < count) { return null; }
        if (starts.length === 0 || starts.length >= Event.MAX_RECURRENCE_EXPANSION) { return null; }

        return starts.map((ms) => {
            const entry = { timeline: EVENTS_TIMELINE, start: new Date(ms).toISOString() };
            if (durationMs !== null) { entry.end = new Date(ms + durationMs).toISOString(); }
            return entry;
        });
    }

    /**
     * Envelope end for a recurring series: the UNTIL instant, or null (open) when
     * the rule is unbounded.
     *
     * COUNT=n deliberately yields an OPEN envelope rather than a computed last
     * occurrence: resolving COUNT requires expanding the rule, and guessing an end
     * risks a series that stops matching before its real final occurrence. An open
     * envelope over-matches, which the client's expansion filters out; a short one
     * would lose occurrences outright, which nothing downstream could recover.
     *
     * @param {string} recurrence RRULE value
     * @returns {string|null} ISO datetime, or null for an open envelope
     */
    static #recurrenceEnvelopeEnd(recurrence) {
        const match = RRULE_UNTIL_RE.exec(recurrence);
        if (!match) { return null; }

        // A date-only UNTIL (RFC-sloppy but common) is inclusive of that day:
        // defaulting to 00:00 would drop same-day occurrences — a real miss,
        // which the timeline planes are contractually not allowed to have.
        const [, y, mo, d, h = '23', mi = '59', s = '59'] = match;
        return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
    }

    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Event(data);
    }

    static get dataSchema() { return documentDataSchema; }

    static get schema() { return baseDocumentSchema; }

    static validate(document) { return baseDocumentSchema.parse(document); }

    static validateData(documentData) { return documentDataSchema.parse(documentData); }
}

export { EVENT_TYPES, EVENTS_TIMELINE };
