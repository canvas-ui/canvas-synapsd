import Document from '../Document.js';
import { z } from 'zod';

const TAB_SCHEMA = 'data/abstraction/tab';

// Tab-specific schema definition
const tabSchema = Document.schemaDefinition.extend({
    type: z.literal('tab'),
    data: z.object({
        url: z.string().url(),
        title: z.string(),
        favicon: z.string().url().nullable(),
        browserName: z.string(),
    })
});

export default class Tab extends Document {
    constructor(options = {}) {
        // Ensure we're using the tab schema
        super({
            ...options,
            schema: TAB_SCHEMA,
            data: {
                url: options.url || '',
                title: options.title || '',
                favicon: options.favicon || null,
                lastVisited: options.lastVisited || new Date().toISOString(),
                isActive: options.isActive || false,
                browserName: options.browserName || '',
                windowId: options.windowId || 0,
                tabId: options.tabId || 0,
                ...options.data
            }
        });
    }

    static get schemaDefinition() {
        return tabSchema;
    }

    get schemaDefinition() {
        return Tab.schemaDefinition;
    }

    // Factory method
    static createFromJSON(json) {
        return new Tab(
            
        );
    }
}
