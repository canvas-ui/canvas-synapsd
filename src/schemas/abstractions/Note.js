import Document from '../Document.js';
import { z } from 'zod';

const NOTE_SCHEMA = 'data/abstraction/note';

// Note-specific schema definition
const noteSchema = Document.schemaDefinition.extend({
    type: z.literal('note'),
    data: z.object({
        title: z.string(),
        content: z.string()
    })
});

class Note extends Document {
    constructor(options = {}) {
        super({
            ...options,
            schema: NOTE_SCHEMA,
            data: {
                title: options.title || '',
                content: options.content || '',
                ...options.data
            }
        });
    }

    static get schemaDefinition() {
        return noteSchema;
    }

    get schemaDefinition() {
        return Note.schemaDefinition;
    }

    updateTitle(newTitle) {
        this.data.title = newTitle;
        this.updated_at = new Date().toISOString();
    }

    updateContent(newContent) {
        this.data.content = newContent;
        this.updated_at = new Date().toISOString();
    }

    get title() { return this.data.title; }
    get content() { return this.data.content; }
}

export default Note;
