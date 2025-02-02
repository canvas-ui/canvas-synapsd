'use strict';

import Document from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA = 'data/abstraction/todo';
const schemaDefinition = Document.schemaDefinition.extend({
    schema: z.literal(DOCUMENT_SCHEMA),
    data: z.object({
        title: z.string(),
        description: z.string(),
        dueDate: z.string().nullable(),
        completed: z.boolean()
    })
});

class Todo extends Document {
    constructor(options = {}) {
        super(options);
        this.type = 'todo';
        this.title = options.title || '';
        this.description = options.description || '';
        this.dueDate = options.dueDate || null;
        this.completed = options.completed || false;
    }

    updateTitle(newTitle) {
        this.title = newTitle;
        this.updated_at = new Date().toISOString();
    }

    updateDescription(newDescription) {
        this.description = newDescription;
        this.updated_at = new Date().toISOString();
    }

    updateDueDate(newDueDate) {
        this.dueDate = newDueDate;
        this.updated_at = new Date().toISOString();
    }

    markAsCompleted() {
        this.completed = true;
        this.updated_at = new Date().toISOString();
    }

    markAsIncomplete() {
        this.completed = false;
        this.updated_at = new Date().toISOString();
    }
}

export default Todo;
