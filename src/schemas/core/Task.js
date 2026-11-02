'use strict';

import Document, { documentSchema as baseDocumentSchema } from '../Document.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/schema/task';
const DOCUMENT_SCHEMA_VERSION = '3.0';

// Task lifecycle aligned with VTODO (RFC 5545) STATUS / JSCalendar (RFC 8984)
// progress: pending=NEEDS-ACTION, in-progress=IN-PROCESS, completed, cancelled.
const TASK_STATUSES = ['pending', 'in-progress', 'completed', 'cancelled'];

// The timeline a due date lands on. Deliberately NOT 'content' — content means
// "when the content came into existence" (EXIF capture etc.); due dates are a
// future-oriented axis. Registered as a point timeline in the Db constructor.
const TASKS_TIMELINE = 'tasks';

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');
const dueDateSchema = z.union([z.string().datetime({ offset: true }), calendarDate])
    .describe('ISO timestamp with timezone, or YYYY-MM-DD. Date-only input becomes 23:59:59.999 in the workspace runtime timezone (TZ/system timezone), stored as UTC. The tasks timeline is derived automatically.')
    .transform(value => {
        if (value.length !== 10) { return new Date(value).toISOString(); }
        const [year, month, day] = value.split('-').map(Number);
        const date = new Date(0);
        date.setFullYear(year, month - 1, day);
        date.setHours(23, 59, 59, 999);
        return date.toISOString();
    });

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    data: z.object({
        title: z.string(),
        description: z.string().optional(),
        status: z.enum(TASK_STATUSES).optional(),
        // Completion is emitted in sync with the canonical status.
        completed: z.boolean().optional(),
        completedAt: z.string().datetime().optional(),
        dueDate: dueDateSchema.optional(),
        // RFC 5545 PRIORITY scale: 1 = highest, 9 = lowest.
        priority: z.number().int().min(1).max(9).optional(),
    }).passthrough(),
    metadata: z.object({}).passthrough().optional(),
});

export default class Task extends Document {

    static exampleData = { title: 'Review migration plan', dueDate: '2026-11-07', priority: 3, status: 'pending' };
    static inputNotes = 'status defaults to pending; completed is synchronized with status. priority is 1 (highest) to 9 (lowest). Do not supply the tasks timeline: it is derived from dueDate.';

    // Index configuration is SCHEMA-level, resolved by Document from this
    // static. Never stored on the row (see documentSchema).
    // Task's status genuinely IS per-document (unlike application install status,
    // which is per-device and lives in locations[].metadata). Declared here rather
    // than hardcoded in the engine.
    static facetFields = ['data.status'];

    static indexOptions = {
        ftsSearchFields: ['data.title', 'data.description'],
        vectorEmbeddingFields: ['data.title', 'data.description'],
        checksumFields: ['data.title', 'data.description', 'data.dueDate'],
    };

    constructor(options = {}) {
        // Set schema before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = DOCUMENT_SCHEMA_VERSION;

        if (options.data?.dueDate !== undefined) {
            options.data.dueDate = z.object({ data: z.object({ dueDate: dueDateSchema }) }).parse(options).data.dueDate;
        }
        Task.#normalizeStatus(options.data);
        options.timelines = Task.#deriveTimelines(options);

        super(options);
    }

    update(changes) {
        if (!changes) { return this; }
        const next = { ...changes };
        if (changes.data) {
            next.data = { ...changes.data };
            if (next.data.dueDate !== undefined) {
                next.data.dueDate = z.object({ data: z.object({ dueDate: dueDateSchema }) }).parse(next).data.dueDate;
            }
            Task.#normalizeStatus(next.data);
        }
        next.timelines = Task.#deriveTimelines({ data: next.data || this.data, timelines: next.timelines || this.timelines });
        return super.update(next);
    }

    // Keep status (canonical) and the completed boolean in sync, both
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
     * Create a Task from minimal data
     * @param {Object} data - Task data
     * @returns {Task} New Task instance
     */
    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Task(data);
    }

    static get dataSchema() {
        return documentDataSchema;
    }

    static get schema() {
        return baseDocumentSchema;
    }

    static validate(document) {
        return baseDocumentSchema.parse(document);
    }

    static validateData(documentData) {
        return documentDataSchema.parse(documentData);
    }
}

export { TASK_STATUSES, TASKS_TIMELINE };
