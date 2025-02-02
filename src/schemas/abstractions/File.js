'use strict';

import Document from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA = 'data/abstraction/file';
const schemaDefinition = Document.schemaDefinition.extend({
    schema: z.literal(DOCUMENT_SCHEMA),
    data: z.object({
        name: z.string(),
        size: z.number().nonnegative(),
        extension: z.string(),
        path: z.string().optional()
    })
});

export default class File extends Document {
    constructor(options = {}) {}
}