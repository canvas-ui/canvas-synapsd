import { documentFeatureKeys, schemaBitmapKeys, facetBitmapKeys } from '../documents/derivation.js';
import { hasSearchContentChanged } from '../documents/snapshot.js';

export function writeFeatureKeys(document, asserted = []) {
    return [...new Set([...asserted, ...documentFeatureKeys(document), ...schemaBitmapKeys(document)])];
}

// The before snapshot is detached before Document.update mutates the row.
// The after document remains owned by preparation until commit; no body copy.
export function preparedChange({ after, before = null, features = [], context = null,
    directories = [null], operation = 'insert', replaceChecksums = false }) {
    const facetKeys = facetBitmapKeys(after);
    return {
        id: after.id, before, after, features, context, directories, operation,
        replaceChecksums, searchChanged: hasSearchContentChanged(before, after),
        staleChecksums: (before?.checksums || []).filter(key => !after.checksumArray.includes(key)),
        staleFeatures: (before?.featureKeys || []).filter(key => !features.includes(key)),
        facetKeys, staleFacets: (before?.facetKeys || []).filter(key => !facetKeys.includes(key)),
    };
}
