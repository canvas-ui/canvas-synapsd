import Document from '../Document.js';
import { z } from 'zod';

const FILE_SCHEMA = 'data/abstraction/file';

// File-specific schema definition
const fileSchema = Document.schemaDefinition.extend({
    type: z.literal('file'),
    data: z.object({
        size: z.number().nonnegative(),
        extension: z.string(),
        path: z.string().optional()
    })
});

class File extends Document {
    constructor(options = {}) {
        super({
            ...options,
            schema: FILE_SCHEMA,
            data: {
                size: options.size || 0,
                extension: options.extension || '',
                path: options.path,
                ...options.data
            }
        });
    }

    static get schemaDefinition() {
        return fileSchema;
    }

    get schemaDefinition() {
        return File.schemaDefinition;
    }

    updateSize(newSize) {
        this.data.size = newSize;
        this.updated_at = new Date().toISOString();
    }

    updateExtension(newExtension) {
        this.data.extension = newExtension;
        this.updated_at = new Date().toISOString();
    }

    get size() { return this.data.size; }
    get extension() { return this.data.extension; }
    get path() { return this.data.path; }
}

export default File;
