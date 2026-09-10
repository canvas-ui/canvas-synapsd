import { normalizeBitmapKeys } from '../indexes/bitmaps/lib/keys.js';


export function isDocumentOperationOptions(value) {
    return Boolean(
        value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            ['context', 'directory', 'features', 'attributes', 'emitEvent', 'provenance'].some((key) => Object.prototype.hasOwnProperty.call(value, key)),
    );
}

export function normalizeWriteFeatures(features) {
    if (features == null) {
        return [];
    }
    let keys;
    if (Array.isArray(features)) {
        keys = normalizeBitmapKeys(features);
    } else if (typeof features === 'object') {
        keys = normalizeBitmapKeys(features.allOf ?? features.features ?? []);
    } else {
        keys = normalizeBitmapKeys(features);
    }
    // 'default' is the VIRTUAL dataset (docs stamped with no dataset,
    // computed at query time) — stamping it physically would make those
    // docs permanently invisible to the dataset selection.
    if (keys.includes('data/dataset/default')) {
        throw new Error('"default" is a reserved dataset name (the virtual unstamped-documents dataset); pick another name');
    }
    return keys;
}

// Write spec: { paths?, features?/attributes?, context?, directory?, emitEvent? }.
// paths use the canonical ctx:/dir: grammar; context/directory are the legacy
// selector form kept until consumers migrate. Returns the internal membership
// shape { context, directory, features, emitEvent }.
export function normalizeDocumentOperationSpec(spec = {}) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { spec = {}; }

    let context = spec.context !== undefined ? spec.context : { path: '/' };
    let directory = spec.directory ?? null;

    if (Array.isArray(spec.paths)) {
        const ctx = [];
        const dir = [];
        for (const token of spec.paths.filter(Boolean)) {
            const body = String(token).replace(/^[+!]/, '');
            if (body.startsWith('dir:')) { dir.push(body.slice(4)); }
            else if (body.startsWith('ctx:')) { ctx.push(body.slice(4)); }
            else { ctx.push(body); }
        }
        // The paths grammar is authoritative: derive BOTH selectors from it and
        // do not retain the implicit root-context default. Otherwise a dir-only
        // op (e.g. unlink from dir:/foo) also targets ctx:/ → "Cannot unlink
        // from root context".
        context = ctx.length > 0 ? { path: ctx.length === 1 ? ctx[0] : ctx } : null;
        directory = dir.length > 0 ? { path: dir.length === 1 ? dir[0] : dir } : null;
    }

    const legacyFeatures = spec.features ?? spec.attributes?.allOf ?? spec.attributes ?? [];
    return {
        context,
        directory,
        features: normalizeWriteFeatures(legacyFeatures),
        emitEvent: spec.emitEvent ?? true,
        provenance: normalizeProvenance(spec.provenance),
    };
}

export function normalizeProvenance(provenance) {
    if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) { return null; }
    const out = {};
    if (typeof provenance.origin === 'string' && provenance.origin) { out.origin = provenance.origin; }
    if (typeof provenance.causedBy === 'string' && provenance.causedBy) { out.causedBy = provenance.causedBy; }
    if (Number.isInteger(provenance.depth) && provenance.depth >= 0) { out.depth = provenance.depth; }
    return Object.keys(out).length > 0 ? out : null;
}

// Caller-supplied provenance rides on emitted events so automation layers
// (workspace hooks/rules) can detect and bound their own cascades. Only the
// three known keys pass through; anything else is dropped.
/**
     * The context PATHS an unlink dropped, for the event's membership delta.
     *
     * Unlinking `/a/b/c` unticks the leaf layer `c`, or every layer along the
     * path when recursive — but a consumer reasoning about "what changed"
     * thinks in paths, not in the layer names a path decomposes into. Layer
     * names were what the payload used to carry under a field called
     * `contextArray`, which silently matched nothing for anyone who read the
     * name literally.
     *
     * @param {string[]} filteredLayers layer names of the path, root removed
     * @param {boolean} recursive
     * @returns {string[]} '/a/b/c', or every prefix of it when recursive
     */
export function unlinkedContextPaths(filteredLayers, recursive) {
    if (filteredLayers.length === 0) { return []; }
    if (!recursive) { return [`/${filteredLayers.join('/')}`]; }
    return filteredLayers.map((_, i) => `/${filteredLayers.slice(0, i + 1).join('/')}`);
}

/** Typed "you named an id that is not here" error — transports map the
     *  code to 404 rather than a generic 500. */
export function documentNotFound(id) {
    const error = new Error(`Document with ID "${id}" not found`);
    error.code = 'ENODOCUMENT';
    return error;
}
