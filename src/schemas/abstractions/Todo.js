'use strict';

import Document, { documentSchema as baseDocumentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/todo';
const DOCUMENT_SCHEMA_VERSION = '2.1';

// Task lifecycle aligned with VTODO (RFC 5545) STATUS / JSCalendar (RFC 8984)
// progress: pending=NEEDS-ACTION, in-progress=IN-PROCESS, completed, cancelled.
const TODO_STATUSES = ['pending', 'in-progress', 'completed', 'cancelled'];

// The timeline a due date lands on. Deliberately NOT 'content' — content means
// "when the content came into existence" (EXIF capture etc.); due dates are a
// future-oriented axis. Registered as a point timeline in the Db constructor.
const TASKS_TIMELINE = 'tasks';

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    data: z.object({
        title: z.string(),
        description: z.string().optional(),
        status: z.enum(TODO_STATUSES).optional(),
        // Legacy boolean kept as accepted input + always emitted in sync with
        // status, so old clients keep working (completed === status 'completed').
        completed: z.boolean().optional(),
        completedAt: z.string().datetime().optional(),
        dueDate: z.string().datetime().optional(),
        // RFC 5545 PRIORITY scale: 1 = highest, 9 = lowest.
        priority: z.number().int().min(1).max(9).optional(),
    }).passthrough(),
    metadata: z.object({}).passthrough().optional(),
});

export default class Todo extends Document {
    constructor(options = {}) {
        // Set schema before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = DOCUMENT_SCHEMA_VERSION;

        // Inject Todo-specific index options BEFORE super()
        // dueDate is part of the checksum: "Call plumber" due Tuesday and
        // "Call plumber" due Friday are different tasks, not dedup candidates.
        options.indexOptions = {
            ...(options.indexOptions || {}),
            ftsSearchFields: ['data.title', 'data.description'],
            vectorEmbeddingFields: ['data.title', 'data.description'],
            checksumFields: ['data.title', 'data.description', 'data.dueDate'],
        };

        Todo.#normalizeStatus(options.data);
        options.timelines = Todo.#deriveTimelines(options);

        super(options);
    }

    // Keep status (canonical) and the legacy completed boolean in sync, both
    // directions, deterministically — this runs on every parse, so it must
    // never invent timestamps or otherwise produce different output per run.
    static #normalizeStatus(data) {
        if (!data || typeof data !== 'object') { return; }
        if (!data.status && data.completed === true) { data.status = 'completed'; }
        if (!data.status) { data.status = 'pending'; }
        data.completed = data.status === 'completed';
    }

    // Due date → 'tasks' timeline entry, derived (doc declares, index derives).
    // Any caller-provided non-tasks entries are preserved; the tasks entry is
    // always regenerated from data.dueDate so it can never drift from the doc.
    static #deriveTimelines(options) {
        const prior = (Array.isArray(options.timelines) ? options.timelines : [])
            .filter((t) => (t?.timeline || t?.name) !== TASKS_TIMELINE);
        const dueDate = options.data?.dueDate;
        if (typeof dueDate === 'string' && dueDate.length > 0) {
            prior.push({ timeline: TASKS_TIMELINE, start: dueDate });
        }
        return prior;
    }

    /**
     * Create a Todo from minimal data
     * @param {Object} data - Todo data
     * @returns {Todo} New Todo instance
     */
    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Todo(data);
    }

    static get dataSchema() {
        return documentDataSchema;
    }

    static get schema() {
        return baseDocumentSchema;
    }

    static get jsonSchema() {
        return {
            schema: DOCUMENT_SCHEMA_NAME,
            data: {
                title: 'string',
            },
        };
    }

    static validate(document) {
        return baseDocumentSchema.parse(document);
    }

    static validateData(documentData) {
        return documentDataSchema.parse(documentData);
    }
}

export { TODO_STATUSES, TASKS_TIMELINE };
