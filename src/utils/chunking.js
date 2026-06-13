'use strict';

/**
 * Text chunking for embedding.
 *
 * Honors a document's `embeddingOptions.chunking` ({ chunkSize, chunkOverlap }).
 * Splits on sentence/paragraph boundaries where possible, falling back to hard
 * character cuts for runs with no boundary (e.g. long URLs, tables). Chunks
 * carry a stable `chunkId` (their ordinal) so re-embedding a document produces
 * the same ids and upserts cleanly.
 */

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;

// Split into boundary-terminated segments: sentence enders or blank lines.
// Keeps the delimiter attached so re-joined text stays faithful.
function segments(text) {
    return text
        .split(/(?<=[.!?])\s+|\n{2,}/u)
        .map(s => s.trim())
        .filter(Boolean);
}

/**
 * @param {string} text
 * @param {{chunkSize?:number, chunkOverlap?:number}} [opts]
 * @returns {{chunkId:number, text:string}[]}
 */
export function chunkText(text, opts = {}) {
    if (typeof text !== 'string') { return []; }
    const trimmed = text.trim();
    if (trimmed.length === 0) { return []; }

    const chunkSize = Math.max(1, Number(opts.chunkSize) || DEFAULT_CHUNK_SIZE);
    const overlap = Math.min(
        Math.max(0, Number(opts.chunkOverlap) || DEFAULT_CHUNK_OVERLAP),
        chunkSize - 1,
    );

    // Short text -> single chunk, no segmentation overhead.
    if (trimmed.length <= chunkSize) {
        return [{ chunkId: 0, text: trimmed }];
    }

    // Pack segments greedily up to chunkSize.
    const segs = segments(trimmed);
    const chunks = [];
    let buf = '';

    const flush = () => {
        const body = buf.trim();
        if (body) { chunks.push(body); }
    };

    for (let seg of segs) {
        // A single oversized segment: hard-cut it with overlap.
        while (seg.length > chunkSize) {
            if (buf) { flush(); buf = ''; }
            chunks.push(seg.slice(0, chunkSize));
            seg = seg.slice(chunkSize - overlap);
        }
        if (buf.length + seg.length + 1 > chunkSize) {
            flush();
            // Carry tail of previous chunk as overlap context.
            buf = overlap > 0 ? buf.slice(-overlap).trim() : '';
        }
        buf = buf ? `${buf} ${seg}` : seg;
    }
    flush();

    return chunks.map((t, chunkId) => ({ chunkId, text: t }));
}

export default chunkText;
