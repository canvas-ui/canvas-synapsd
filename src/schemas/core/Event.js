'use strict';

import Document, { documentSchema as baseDocumentSchema } from '../Document.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/event';
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
        // 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T235959Z'. Stored verbatim and NOT
        // expanded server-side — see the envelope note on #deriveTimelines.
        // Deliberately not in checksumFields: editing the rule edits the series,
        // it does not create a new event (CalDAV keeps the same UID).
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

    // start/end → 'events' timeline entry, derived (doc declares, index derives).
    // Caller-provided non-events entries are preserved; the events entry is always
    // regenerated from the data so it can never drift from the document.
    //
    // RECURRENCE — the envelope model (decided 2026-08-03). A document occupies
    // exactly ONE position per timeline: the index is a BSI keyed id -> a single
    // value, so a second insert for the same (timeline, id) OVERWRITES the first.
    // Recurring series therefore cannot be expanded into N timeline entries on one
    // document. Instead the entry spans an ENVELOPE — first occurrence to UNTIL,
    // or open when the rule never ends — and the client expands the RRULE to
    // render real occurrences, exactly as a CalDAV client already does with
    // VEVENT+RRULE.
    //
    // The envelope is a deliberate SUPERSET: a weekly standup answers a query for
    // any day inside its span until the rule is expanded. That is the same
    // candidate-set-then-refine contract the rest of the engine uses; it never
    // misses an occurrence, which is the property that matters for a bitmap
    // pre-filter.
    static #deriveTimelines(options) {
        const prior = (Array.isArray(options.timelines) ? options.timelines : [])
            .filter((t) => (t?.timeline || t?.name) !== EVENTS_TIMELINE);

        const data = options.data ?? {};
        const start = data.start;
        if (typeof start === 'string' && start.length > 0) {
            const entry = { timeline: EVENTS_TIMELINE, start };
            const recurrence = data.recurrence;

            if (typeof recurrence === 'string' && recurrence.length > 0) {
                // `data.end` still describes ONE occurrence's duration, so it must
                // not become the envelope end — the envelope comes from the rule.
                entry.end = Event.#recurrenceEnvelopeEnd(recurrence);
            } else if ('end' in data) {
                // Distinguish "no end" (instant) from an explicit null (ongoing):
                // omitting the key entirely is what the Timeline index reads as an
                // instant, so we must not write `end: undefined`.
                entry.end = data.end;
            }

            prior.push(entry);
        }

        return prior;
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

        const [, y, mo, d, h = '00', mi = '00', s = '00'] = match;
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
