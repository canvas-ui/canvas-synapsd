'use strict';

import Document, { documentSchema as baseDocumentSchema } from '../BaseDocument.js';
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
    }).passthrough(),
);

export default class Event extends Document {
    constructor(options = {}) {
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = DOCUMENT_SCHEMA_VERSION;

        // Injected BEFORE super() so the checksum uses these fields.
        // start and type are in the checksum for the same reason Todo puts
        // dueDate there: "Standup" at 09:00 and "Standup" at 14:00 are different
        // events, and a calendar entry is not the alert that shares its title.
        options.indexOptions = {
            ...(options.indexOptions || {}),
            ftsSearchFields: ['data.title', 'data.description', 'data.location'],
            vectorEmbeddingFields: ['data.title', 'data.description'],
            checksumFields: ['data.title', 'data.start', 'data.type'],
        };

        options.timelines = Event.#deriveTimelines(options);

        super(options);
    }

    // start/end → 'events' timeline entry, derived (doc declares, index derives).
    // Caller-provided non-events entries are preserved; the events entry is always
    // regenerated from the data so it can never drift from the document.
    static #deriveTimelines(options) {
        const prior = (Array.isArray(options.timelines) ? options.timelines : [])
            .filter((t) => (t?.timeline || t?.name) !== EVENTS_TIMELINE);

        const start = options.data?.start;
        if (typeof start === 'string' && start.length > 0) {
            const entry = { timeline: EVENTS_TIMELINE, start };
            // Distinguish "no end" (instant) from an explicit null (ongoing):
            // omitting the key entirely is what the Timeline index reads as an
            // instant, so we must not write `end: undefined`.
            if ('end' in (options.data ?? {})) { entry.end = options.data.end; }
            prior.push(entry);
        }

        return prior;
    }

    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Event(data);
    }

    static get dataSchema() { return documentDataSchema; }

    static get schema() { return baseDocumentSchema; }

    static get jsonSchema() {
        return {
            schema: DOCUMENT_SCHEMA_NAME,
            data: {
                title: 'string',
                type: EVENT_TYPES.join('|'),
                start: 'string',
            },
        };
    }

    static validate(document) { return baseDocumentSchema.parse(document); }

    static validateData(documentData) { return documentDataSchema.parse(documentData); }
}

export { EVENT_TYPES, EVENTS_TIMELINE };
