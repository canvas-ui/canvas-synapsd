'use strict';

import BaseDocument from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA = 'data/abstraction/note';
const schemaDefinition = BaseDocument.schemaDefinition.extend({
    schema: z.literal(DOCUMENT_SCHEMA),
    data: z.object({
        title: z.string().optional().nullable(),
        content: z.string()
    })
});

export default class Note extends BaseDocument {
    constructor(options = {}) {
        super({
            ...options,
            schema: DOCUMENT_SCHEMA,
            data: {
                title: options.title ?? null,
                content: options.content,
                ...options.data
            },
            index: {
                ...options.index,
                searchFields: ['data.title', 'data.content'],
                checksumFields: ['data.content']
            }
        });
    }

    static get schemaDefinition() {
        return schemaDefinition;
    }

    get schemaDefinition() {
        return Note.schemaDefinition;
    }

    get title() { return this.data.title; }
    get content() { return this.data.content; }

    /**
     * Create a note from input data
     * @param {string|Object} input Note content or data object
     * @param {Object} options Additional options
     * @returns {Note} New note instance
     */
    static fromData(input, options = {}) {
        return this.create({
            content: typeof input === 'string' ? input : input.content,
            title: options.title || (typeof input === 'string' ? this.generateDefaultTitle(input) : input.title)
        });
    }

    static normalizeInputData(input) {
        if (typeof input === 'string') {
            return {
                content: input,
                title: this.generateDefaultTitle(input)
            };
        }
        return input;
    }

    static generateDefaultTitle(content) {
        return content.split('\n')[0].slice(0, 50) || 'Untitled Note';
    }

    /**
     * Validates the note document
     * @throws {Error} If validation fails
     * @returns {boolean} True if validation passes
     */
    validate() {
        // First run base validation
        super.validate();

        try {
            // Note-specific schema validation
            Note.schemaDefinition.parse(this);
            return true;
        } catch (error) {
            throw new Error(`Note validation failed: ${error.message}`);
        }
    }

    /**
     * Static method to validate note data
     * @param {Object} data - Data to validate
     * @throws {Error} If validation fails
     * @returns {boolean} True if validation passes
     */
    static validateData(data) {
        try {
            schemaDefinition.shape.data.parse(data);
            return true;
        } catch (error) {
            throw new Error(`Note data validation failed: ${error.message}`);
        }
    }
}
