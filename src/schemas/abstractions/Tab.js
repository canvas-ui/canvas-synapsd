'use strict';

import BaseDocument from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA = 'data/abstraction/tab';
const schemaDefinition = BaseDocument.schemaDefinition.extend({
    schema: z.literal(DOCUMENT_SCHEMA),
    data: z.object({
        url: z.string().url(),
        title: z.string().optional().nullable(),
        favicon: z.string().url().optional().nullable()
    })
});

export default class Tab extends BaseDocument {
    static schemaType = 'tab';

    constructor(options = {}) {
        super({
            ...options,
            schema: DOCUMENT_SCHEMA,
            data: {
                url: options.url,
                title: options.title ?? null,
                favicon: options.favicon ?? null,
                ...options.data
            },
            index: {
                ...options.index,
                searchFields: ['data.url', 'data.title'],
                checksumFields: ['data.url']
            }
        });
    }

    static get schemaDefinition() {
        return schemaDefinition;
    }

    get schemaDefinition() {
        return Tab.schemaDefinition;
    }

    get url() { return this.data.url; }
    get title() { return this.data.title; }
    get favicon() { return this.data.favicon; }

    /**
     * Validates the tab document
     * @throws {Error} If validation fails
     * @returns {boolean} True if validation passes
     */
    validate() {
        // First run base validation
        super.validate();

        try {
            // Tab-specific schema validation
            Tab.schemaDefinition.parse(this);
            return true;
        } catch (error) {
            throw new Error(`Tab validation failed: ${error.message}`);
        }
    }

    /**
     * Static method to validate tab data
     * @param {Object} data - Data to validate
     * @throws {Error} If validation fails
     * @returns {boolean} True if validation passes
     */
    static validateData(data) {
        try {
            schemaDefinition.shape.data.parse(data);
            return true;
        } catch (error) {
            throw new Error(`Tab data validation failed: ${error.message}`);
        }
    }
}
