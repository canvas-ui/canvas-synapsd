'use strict';

// Utils
import { z } from 'zod';

const MetadataSchema = z.object({
    id: z.number().int().positive(),
    created_at: z.string(),
    updated_at: z.string(),
    status: z.enum(['active', 'deleted', 'freed']),
});

export default class Metadata {
    static schemaType = 'metadata';

    constructor(options = {}) {
        this.id = options.id;
        this.created_at = options.created_at;
        this.updated_at = options.updated_at;
        this.status = options.status;
    }

    static validate(metadata) {
        return MetadataSchema.parse(metadata);
    }

}
