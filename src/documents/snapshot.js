'use strict';

import { documentFeatureKeys, documentRelations, facetBitmapKeys, schemaBitmapKeys } from './derivation.js';

// Only capture fields used by index diffs, not the document's potentially large
// body. Location derivation reads URLs and declared backends, not arbitrary protocol metadata.
// Detach timeline entries before freezing so the snapshot neither aliases nor
// freezes the caller's mutable document.
export function snapshotDocument(doc) {
    if (!doc) { return null; }
    return freezeSnapshot({
        checksums: Array.isArray(doc.checksumArray) ? [...doc.checksumArray] : [],
        locations: Array.isArray(doc.locations) ? doc.locations.map(location => ({
            url: location?.url,
            metadata: typeof location?.metadata?.backend === 'string'
                ? { backend: location.metadata.backend } : undefined,
        })) : [],
        orphanedAt: doc.orphanedAt || null,
        schema: typeof doc.schema === 'string' ? doc.schema : null,
        updatedAt: doc.updatedAt || null,
        version: Number.isInteger(doc.version) && doc.version > 0 ? doc.version : 1,
        comment: typeof doc.comment === 'string' ? doc.comment : '',
        summary: typeof doc.metadata?.summary === 'string' ? doc.metadata.summary : '',
        text: typeof doc.metadata?.text?.content === 'string' ? doc.metadata.text.content : '',
        timelines: Array.isArray(doc.timelines) ? structuredClone(doc.timelines) : [],
        facetKeys: facetBitmapKeys(doc),
        featureKeys: [...documentFeatureKeys(doc), ...schemaBitmapKeys(doc)],
        relations: documentRelations(doc),
    });
}

function freezeSnapshot(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) { freezeSnapshot(child); }
        Object.freeze(value);
    }
    return value;
}

// Blob checksums describe bytes. Comment, summary, and late extracted text can
// change searchable content independently, so all four inputs matter.
export function hasSearchContentChanged(previous, doc) {
    if (!previous) { return true; }
    if (previous.comment !== (typeof doc.comment === 'string' ? doc.comment : '')) { return true; }
    if (previous.summary !== (typeof doc.metadata?.summary === 'string' ? doc.metadata.summary : '')) { return true; }
    if (previous.text !== (typeof doc.metadata?.text?.content === 'string' ? doc.metadata.text.content : '')) { return true; }
    const current = doc.checksumArray || [];
    if (previous.checksums.length !== current.length) { return true; }
    const checksums = new Set(previous.checksums);
    return current.some(checksum => !checksums.has(checksum));
}

const sameSet = (a, b) => a.length === b.length && a.every(value => b.includes(value));
const urls = locations => (Array.isArray(locations) ? locations : []).map(location => location?.url).filter(Boolean);

/**
 * The location URLs an update removed and added, when that is all it did:
 * same bytes, schema, features, facets, relations, timelines, comment and
 * extracted text. Null for any other update, and for one that left the URLs
 * alone. Descriptive metadata (a filename) may ride along.
 */
export function relocation(previous, doc) {
    if (!previous || hasSearchContentChanged(previous, doc)) { return null; }
    if (previous.schema !== (typeof doc.schema === 'string' ? doc.schema : null)) { return null; }
    if (previous.orphanedAt !== (doc.orphanedAt || null)) { return null; }
    if (!sameSet(previous.featureKeys, [...documentFeatureKeys(doc), ...schemaBitmapKeys(doc)])) { return null; }
    if (!sameSet(previous.facetKeys, facetBitmapKeys(doc))) { return null; }
    if (JSON.stringify(previous.relations) !== JSON.stringify(documentRelations(doc))) { return null; }
    if (JSON.stringify(previous.timelines) !== JSON.stringify(Array.isArray(doc.timelines) ? doc.timelines : [])) { return null; }
    const before = urls(previous.locations);
    const after = urls(doc.locations);
    const from = before.filter(url => !after.includes(url));
    const to = after.filter(url => !before.includes(url));
    return from.length || to.length ? { from, to } : null;
}
