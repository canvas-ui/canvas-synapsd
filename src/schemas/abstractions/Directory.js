'use strict';

import Document from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA = 'data/abstraction/directory';
const schemaDefinition = Document.schemaDefinition.extend({
    schema: z.literal(DOCUMENT_SCHEMA),
    data: z.object({
        name: z.string(),
        path: z.string(),
        children: z.array(z.string())
    })
});

export default class Directory extends Document {
    constructor(options = {}) {}
}
