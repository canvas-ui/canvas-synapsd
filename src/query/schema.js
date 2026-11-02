import { PREDICATES } from '../indexes/edges/predicates.js';

const strings = { type: 'array', items: { type: 'string' } };
const id = { type: 'integer', minimum: 1, maximum: 4294967295 };
const path = { anyOf: [{ type: 'string' }, strings] };
const selector = {
    type: 'object', additionalProperties: false,
    properties: {
        tree: { type: 'string', description: 'Tree name or ID; omitted selects the default tree.' },
        path,
        recursive: { type: 'boolean', description: 'Directory subtree membership. Default false (exact folder).' },
        currentPathOnly: { type: 'boolean', description: 'Subtract descendant matches from context membership. Does not identify explicit filing locations or preserve parent-link history.' },
    },
};
const pathEntry = { anyOf: [{ type: 'string' }, { ...selector, properties: { ...selector.properties, type: { enum: ['context', 'directory'] } } }] };
const relation = {
    type: 'object', additionalProperties: false, required: ['p', 'of'],
    properties: {
        p: { type: 'string', enum: Object.keys(PREDICATES) },
        of: { anyOf: [id, { type: 'array', items: id, minItems: 1 }], description: 'Anchor ID(s); arrays union the anchors before applying op.' },
        dir: { enum: ['in', 'out'], description: 'out (default): targets of anchors. in: documents pointing to anchors.' },
        op: { enum: ['anyOf', 'allOf', 'noneOf'], description: 'OR, required gate, or exclusion. Default anyOf.' },
    },
};
const rel = { anyOf: [relation, { type: 'array', items: relation }] };

/** Public candidate contract, shared by transport schemas and compound lines. */
export const candidateSpecSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        paths: {
            description: 'Positive paths OR together; exclusions subtract. ctx:/ and dir:/ address default trees. Use selector objects for named trees. Buckets (paths, features, filters, rel, ids) intersect.',
            anyOf: [
                { type: 'array', items: pathEntry },
                { type: 'object', additionalProperties: false, properties: { in: { type: 'array', items: pathEntry }, not: { type: 'array', items: pathEntry } } },
            ],
        },
        context: { anyOf: [{ type: 'null' }, { type: 'string' }, strings, selector], description: 'Bitmap context selector: /foo/bar/baz means foo AND bar AND baz. Linking ticks each node; shorter paths widen membership. No explicit filing location is stored. ORed with other positive paths.' },
        directory: { anyOf: [{ type: 'null' }, { type: 'string' }, strings, selector], description: 'Filesystem-like directory selector: exact folder membership by default; recursive: true ORs this folder and its descendants. ORed with other positive paths.' },
        features: {
            description: 'Bitmap keys: bare = anyOf/OR, + = allOf/required, ! = noneOf/excluded. Examples: feature/email/attachment, data/schema/message/email, data/mime/application/pdf, tag/finance. MIME describes this document, not its relation targets.',
            anyOf: [strings, { type: 'object', additionalProperties: false, properties: { allOf: strings, anyOf: strings, noneOf: strings } }],
        },
        filters: { ...strings, description: 'Temporal: t:content:2026-10-01..2026-10-31, t:crud:updated:thisWeek. Spatial: geo:near:48.1,17.1,5km or geo:bbox:minLat,minLon,maxLat,maxLon. Bare temporal/spatial tokens OR; + requires and ! excludes. Raw bitmap keys AND.' },
        rel,
        ids: { type: 'array', items: id, description: 'Intersect these document IDs. An empty array matches nothing.' },
    },
};

export const queryOptionsSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        mode: { enum: ['hybrid', 'fts', 'vector'] },
        limit: { type: 'integer', minimum: 0, description: 'Page size; 0 explicitly requests all matches.' },
        offset: { type: 'integer', minimum: 0 },
        page: { type: 'integer', minimum: 1, description: 'One-based page; offset takes precedence.' },
        order: { enum: ['asc', 'desc'] },
        sortBy: { type: 'string', description: 'Timeline name (content, crud:created, etc.). Structural listings only; text queries remain relevance ranked.' },
        parse: { type: 'boolean', description: 'False returns raw stored documents.' },
        idsOnly: { type: 'boolean', description: 'Return IDs without loading documents; totalCount precedes pagination.' },
        countOnly: { type: 'boolean', description: 'Return an empty page and totalCount. Structural queries use bitmap cardinality without loading documents. Takes precedence over idsOnly.' },
        groupBy: { type: 'string' },
        minDistance: { type: 'number', minimum: 0, maximum: 2 },
        maxDistance: { type: 'number', minimum: 0, maximum: 2 },
        debug: { type: 'boolean' },
        debugLimit: { type: 'integer', minimum: 1, maximum: 500 },
        rel,
    },
};

/** The native read spec. Top-level options override nested options. */
export const querySpecSchema = {
    ...candidateSpecSchema,
    properties: {
        ...candidateSpecSchema.properties,
        ...queryOptionsSchema.properties,
        options: { ...queryOptionsSchema, description: 'Read options; explicitly supplied top-level values take precedence.' },
        query: {
            description: 'Optional ranking query. Omit for a bitmap listing/count. Vectors are caller-supplied embeddings; use the workspace image-search API to embed image bytes.',
            anyOf: [
                { type: 'string', minLength: 1 },
                {
                    type: 'object', additionalProperties: false,
                    anyOf: [{ required: ['text'] }, { required: ['vectors'] }],
                    properties: {
                        text: { type: 'string', minLength: 1 },
                        vectors: {
                            type: 'array', minItems: 1,
                            items: {
                                type: 'object', additionalProperties: false, required: ['space', 'vector'],
                                properties: {
                                    space: { type: 'string' }, vector: { type: 'array', minItems: 1, items: { type: 'number' } },
                                    weight: { type: 'number', exclusiveMinimum: 0 },
                                    minDistance: { type: 'number', minimum: 0, maximum: 2 },
                                    maxDistance: { type: 'number', minimum: 0, maximum: 2 },
                                },
                            },
                        },
                    },
                },
            ],
        },
    },
};
