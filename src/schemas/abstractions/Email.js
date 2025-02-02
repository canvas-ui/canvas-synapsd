'use strict';

import Document from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA = 'data/abstraction/email';
const schemaDefinition = Document.schemaDefinition.extend({
    schema: z.literal(DOCUMENT_SCHEMA),
    data: z.object({
        from: z.string(),
        to: z.string(),
        subject: z.string(),
        body: z.string()
    })
});

export default class Email extends Document {
    constructor(options = {}) {
        super({
            ...options,
            schema: DOCUMENT_SCHEMA,
            data: {
                from: options.from || '',
                to: options.to || '',
                subject: options.subject || '',
                body: options.body || '',
                ...options.data
            }
        });
    }

    static get schemaDefinition() {
        return schemaDefinition;
    }

    get schemaDefinition() {
        return Email.schemaDefinition;
    }

    validate() {
        // First run base validation
        super.validate();

        // Note-specific validation
        if (!this.data.content) throw new Error('Note content required');
        if (typeof this.data.content !== 'string') throw new Error('Note content must be a string');

        // Add any other note-specific validation rules
        return true;
    }

    static validateData(data) {
        // First run base validation
        super.validateData(data);

        // Note-specific validation
        if (!data.content) throw new Error('Note content required');
        if (typeof data.content !== 'string') throw new Error('Note content must be a string');

        return true;
    }
}
