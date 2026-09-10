'use strict';

// Merge schema-declared record fields from the stored document into an incoming
// one that resolved to it by checksum. Incoming keys WIN; keys the incoming write
// omitted survive. Without this, the checksum-match path replaces the stored
// document wholesale (only id/createdAt/updatedAt carry over), so a partial write
// silently destroys state it never knew about — e.g. a dotfile POST carrying one
// device's mapping wiping every other device's.
//
// Schema-declared (`static mergeOnDedupe`) rather than hardcoded, so the engine
// stays schema-agnostic.
export function mergeDedupePreservedFields(parsed, existing) {
    const paths = parsed?.constructor?.mergeOnDedupe;
    if (!Array.isArray(paths) || paths.length === 0 || !existing) { return parsed; }

    let changed = false;
    for (const dotted of paths) {
        const segments = dotted.split('.');
        const key = segments.pop();
        const target = segments.reduce((acc, seg) => (acc == null ? acc : acc[seg]), parsed);
        const source = segments.reduce((acc, seg) => (acc == null ? acc : acc[seg]), existing);
        const prior = source?.[key];
        if (!prior || typeof prior !== 'object' || Array.isArray(prior) || !target) { continue; }

        const incoming = (target[key] && typeof target[key] === 'object' && !Array.isArray(target[key]))
            ? target[key]
            : {};
        target[key] = { ...prior, ...incoming };
        changed = true;
    }

    // Locations derive from these fields for some schemas (Dotfile links), so a
    // merge that widens the map must widen the derived locations with it.
    if (changed && typeof parsed.deriveLocations === 'function') {
        const derived = parsed.deriveLocations();
        if (derived) { parsed.locations = derived; }
    }

    return parsed;
}

// Union extra locations into a document by url (used by in-batch content dedup,
// where two identical blobs carry different file:// locations). Mutates target.
export function mergeDocumentLocations(target, extraLocations) {
    if (!Array.isArray(extraLocations) || extraLocations.length === 0) { return; }
    if (!Array.isArray(target.locations)) { target.locations = []; }
    const seen = new Set(target.locations.map((l) => l && l.url));
    for (const loc of extraLocations) {
        if (loc && loc.url && !seen.has(loc.url)) {
            target.locations.push(loc);
            seen.add(loc.url);
        }
    }
}

