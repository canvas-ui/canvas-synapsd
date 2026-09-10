'use strict';

import { documentFeatureKeys, documentRelations, facetBitmapKeys, schemaBitmapKeys } from './derivation.js';

// Only capture fields used by index diffs, not the document's potentially large
// body. Location derivation reads only URLs, not arbitrary protocol metadata.
// Detach timeline entries before freezing so the snapshot neither aliases nor
// freezes the caller's mutable document.
export function snapshotDocument(doc) {
    if (!doc) { return null; }
    return freezeSnapshot({
        checksums: Array.isArray(doc.checksumArray) ? [...doc.checksumArray] : [],
        locations: Array.isArray(doc.locations) ? doc.locations.map(location => ({ url: location?.url })) : [],
        orphanedAt: doc.orphanedAt || null,
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
