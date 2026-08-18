'use strict';

import crypto from 'crypto';

/**
 * Canonical event names for SynapsD.
 *
 * Every emit() call in the module MUST use one of these constants.
 * Consumers (transports, workspace, context) match on the same strings
 * via wildcard forwarding, so renaming here renames everywhere.
 */
const EVENTS = Object.freeze({

    // Lifecycle
    STARTED:          'started',
    BEFORE_SHUTDOWN:  'beforeShutdown',
    SHUTDOWN:         'shutdown',

    // Document CRUD
    //
    // ── `reason`: what changed ──────────────────────────────────────────────
    // EVERY document.* event carries a `reason` from this closed set, so a
    // consumer can branch on ONE field instead of inferring meaning from the
    // payload's shape (which is how a membership-only update used to look like
    // a content update with a mysteriously absent document):
    //
    //   'created'     the document came into existence      (inserted)
    //   'content'     the document itself changed           (updated)
    //   'membership'  only its tree placement changed       (updated/linked/
    //                                                        removed/unlinked)
    //   'deleted'     it was removed from the index         (deleted)
    //
    // Two things follow from this that consumers get wrong otherwise:
    //
    //  - `document.updated` fires for BOTH 'content' and 'membership'. Only the
    //    'content' form carries `document`; the 'membership' form carries
    //    `changed` and no document. The membership form is always accompanied
    //    by the first-class document.linked / document.unlinked, which DO carry
    //    the document — prefer those for automation. (The membership form is
    //    deprecated; see DOCUMENT_LINKED below.)
    //  - `changed` is the CHANGED placement, never the document's full
    //    placement. "Is this filed under /x" is state: read it, do not infer it
    //    from an event.
    //
    // `batch` is an orthogonal axis: it describes payload SHAPE (ids vs a
    // document), not what changed. Both axes are independent.
    //
    // Adding an emit site? Stamp `reason`. tests/event-payload-contract.test.js
    // fails on any document.* event that omits it or uses a value outside the
    // set above.
    DOCUMENT_INSERTED: 'document.inserted',
    DOCUMENT_UPDATED:  'document.updated',
    DOCUMENT_REMOVED:  'document.removed',
    DOCUMENT_DELETED:  'document.deleted',
    // Membership changes as first-class events. linked/unlinked carry the full
    // document so automation (workspace hooks/rules) can match on content.
    //
    // DEPRECATED alongside them: link/unlink ALSO emit membership-only
    // document.updated / document.removed for consumers that predate these
    // names. Those forms carry no document, which is exactly the trap `reason`
    // documents — they are scheduled for removal in the next major (see
    // README, "Membership events"). Bind linked/unlinked instead.
    DOCUMENT_LINKED:   'document.linked',
    DOCUMENT_UNLINKED: 'document.unlinked',
    // Batch counterparts, so a bulk link/unlink has a first-class event too.
    // Without these the alias could not be retired: linkMany/unlinkMany had
    // NOTHING but the membership-only forms, so a rule bound to
    // document.linked fired on a one-document link and silently never on a
    // multi-select one.
    DOCUMENT_LINKED_BATCH:   'document.linked.batch',
    DOCUMENT_UNLINKED_BATCH: 'document.unlinked.batch',
    // Batch variants: a single event for a bulk op (batch insert / purge /
    // bulk remove) so a 1000-doc operation does not fan out into 1000 socket
    // emits. Insert/update batches ALSO emit the singular event once with
    // `{ ids, batch: true }` for consumers that predate the batch names.
    DOCUMENT_INSERTED_BATCH: 'document.inserted.batch',
    DOCUMENT_UPDATED_BATCH: 'document.updated.batch',
    DOCUMENT_REMOVED_BATCH: 'document.removed.batch',
    DOCUMENT_DELETED_BATCH: 'document.deleted.batch',
    // Low-level bitmap-membership change, emitted post-commit with the exact
    // collection keys ticked/unticked. Drives precise live invalidation for
    // long-running query sessions (QuerySession). Payload: { changes:[{docId,op,keys}] }.
    MEMBERSHIP_CHANGED: 'membership.changed',

    // Tree management
    TREE_CREATED: 'tree.created',
    TREE_DELETED: 'tree.deleted',
    TREE_RENAMED: 'tree.renamed',

    // Tree structural operations
    TREE_PATH_INSERTED:  'tree.path.inserted',
    TREE_PATH_MOVED:     'tree.path.moved',
    TREE_PATH_COPIED:    'tree.path.copied',
    TREE_PATH_REMOVED:   'tree.path.removed',
    TREE_PATH_LOCKED:    'tree.path.locked',
    TREE_PATH_UNLOCKED:  'tree.path.unlocked',

    // Tree layer operations
    TREE_LAYER_MERGED:     'tree.layer.merged',
    TREE_LAYER_SUBTRACTED: 'tree.layer.subtracted',
    TREE_LAYER_CONVERTED:  'tree.layer.converted',
    TREE_LAYER_UPDATED:    'tree.layer.updated',

    // Tree document operations
    TREE_DOCUMENT_INSERTED:       'tree.document.inserted',
    TREE_DOCUMENT_INSERTED_BATCH: 'tree.document.inserted.batch',
    TREE_DOCUMENT_REMOVED:        'tree.document.removed',
    TREE_DOCUMENT_REMOVED_BATCH:  'tree.document.removed.batch',
    TREE_DOCUMENT_DELETED:        'tree.document.deleted',
    TREE_DOCUMENT_DELETED_BATCH:  'tree.document.deleted.batch',

    // Tree lifecycle
    TREE_RECALCULATED: 'tree.recalculated',
    TREE_SAVED:        'tree.saved',
    TREE_LOADED:       'tree.loaded',
    TREE_ERROR:        'tree.error',
});

/**
 * Common event envelope for all SynapsD events.
 *
 * Every payload emitted through the event system gets wrapped in this shape.
 * Consumers never have to guess which fields are present on the envelope
 * vs. which are event-specific — the envelope is always flat with a fixed
 * set of top-level keys plus the spread detail object.
 *
 * Shape:
 *   {
 *     event:     string,   // canonical event name
 *     eventId:   string,   // unique per emit — idempotency/provenance key
 *     source:    string,   // originator: 'db' | 'tree' | caller-provided
 *     timestamp: string,   // ISO 8601
 *     origin:    string,   // provenance: 'user' | 'hook' | 'rule' | 'agent' | 'backfill' | 'replay'
 *     causedBy:  ?string,  // eventId of the event whose automation caused this write
 *     depth:     number,   // automation cascade depth (0 = direct user/system write)
 *     treeId:    ?string,  // present on tree-scoped events
 *     treeName:  ?string,
 *     treeType:  ?string,
 *     ...detail            // event-specific fields
 *   }
 */
// Envelope keys the caller MAY set through `detail` — every one of them is
// read by the constructor below on purpose (provenance stamping, tree
// attribution, replayed envelopes reusing an eventId). They are listed for
// documentation and for the assertion, not as a prohibition.
const ENVELOPE_INPUT_KEYS = Object.freeze([
    'eventId', 'source', 'timestamp', 'origin', 'causedBy', 'depth',
    'treeId', 'treeName', 'treeType',
]);

// ...and the one key it OWNS. `this.event` is assigned before the spread, and
// the spread skips keys already present, so a `detail.event` is silently
// dropped — the emit site believes it set the event name and nothing says
// otherwise. That silence is the whole reason this assertion exists.
const ENVELOPE_OWNED_KEYS = Object.freeze(['event']);

const DEV = process.env.NODE_ENV !== 'production';

/**
 * Dev-mode guard against emit sites that quietly lose data to the envelope.
 *
 * Two failure modes, both silent in production today:
 *   - `detail.event` — dropped (see above).
 *   - a malformed envelope input — `depth: '1'` or `origin: 42` fails the
 *     constructor's type test and falls back to the default, so a cascade
 *     guard reads depth 0 and never terminates.
 *
 * Off in production: an emit site is on the write path, and a payload typo
 * must not be able to fail a committed write.
 */
function assertEventDetail(event, detail) {
    if (!DEV || !detail || typeof detail !== 'object') { return; }

    for (const key of ENVELOPE_OWNED_KEYS) {
        if (key in detail) {
            throw new Error(`SynapsDEvent("${event}"): detail.${key} is owned by the envelope and would be silently ignored — pass it as the first argument instead`);
        }
    }

    if ('depth' in detail && detail.depth !== undefined && !(Number.isInteger(detail.depth) && detail.depth >= 0)) {
        throw new Error(`SynapsDEvent("${event}"): detail.depth must be a non-negative integer, got ${JSON.stringify(detail.depth)} (it would silently default to 0 and disable cascade termination)`);
    }
    if ('origin' in detail && detail.origin !== undefined && detail.origin !== null && typeof detail.origin !== 'string') {
        throw new Error(`SynapsDEvent("${event}"): detail.origin must be a string, got ${typeof detail.origin}`);
    }
    if ('causedBy' in detail && detail.causedBy !== undefined && detail.causedBy !== null && typeof detail.causedBy !== 'string') {
        throw new Error(`SynapsDEvent("${event}"): detail.causedBy must be an eventId string or null, got ${typeof detail.causedBy}`);
    }
}

class SynapsDEvent {
    constructor(event, detail = {}, source = 'db') {
        assertEventDetail(event, detail);
        this.event = event;
        this.eventId = detail.eventId ?? crypto.randomUUID();
        this.source = detail.source ?? source;
        this.timestamp = detail.timestamp ?? new Date().toISOString();
        this.origin = detail.origin ?? 'user';
        this.causedBy = detail.causedBy ?? null;
        this.depth = Number.isInteger(detail.depth) ? detail.depth : 0;
        this.treeId = detail.treeId ?? null;
        this.treeName = detail.treeName ?? null;
        this.treeType = detail.treeType ?? null;

        for (const [key, value] of Object.entries(detail)) {
            if (!(key in this)) {
                this[key] = value;
            }
        }
    }
}

function createEvent(event, detail = {}, source = 'db') {
    return new SynapsDEvent(event, detail, source);
}

function createTreeEvent(event, tree, detail = {}) {
    return new SynapsDEvent(event, {
        treeId: tree?.id ?? null,
        treeName: tree?.name ?? null,
        treeType: tree?.type ?? null,
        ...detail,
    }, 'tree');
}

// The closed `reason` vocabulary, exported so consumers (and the contract
// test) validate against the same list the emitter uses.
const DOCUMENT_EVENT_REASONS = Object.freeze(['created', 'content', 'membership', 'deleted']);

/**
 * Tree paths named by a context/directory selector, as a flat array.
 *
 * Selectors are polymorphic by design ('/a/b', { path }, { tree, path },
 * { paths: [...] }, or an array of any of those). Event consumers should not
 * have to re-implement that union to answer "which paths changed", so the
 * membership delta normalizes it once, here. Never throws: an unrecognized
 * selector contributes no paths rather than failing a committed write.
 */
function selectorPaths(spec) {
    if (!spec) { return []; }
    const list = Array.isArray(spec) ? spec : [spec];
    const out = [];
    for (const entry of list) {
        if (typeof entry === 'string') {
            if (entry) { out.push(entry); }
        } else if (entry && typeof entry === 'object') {
            const p = entry.path ?? entry.paths;
            if (typeof p === 'string' && p) { out.push(p); }
            else if (Array.isArray(p)) { out.push(...p.filter((x) => typeof x === 'string' && x)); }
        }
    }
    return out;
}

/**
 * The membership delta block carried by every membership event.
 *
 * `changed` is the canonical shape — path arrays on both the link and the
 * unlink side, so one consumer branch handles both:
 *
 *   { context: ['/inbox'], directory: [], features: ['tag/foo'] }
 *
 * It is a DELTA: the placements this operation added or removed, never the
 * document's full placement. Asking "is this filed under /x" means reading the
 * bitmaps — an event cannot answer it (and making it able to would mean
 * loading placement for every document in a 10k bulk link).
 *
 * The remaining keys are DEPRECATED aliases kept for one release, in their
 * original shapes:
 *   - `memberships` — the raw selectors as passed in (link side).
 *   - `contextArray` / `directoryArray` / `featureArray` (unlink side).
 * They go away together with the membership-only document.updated /
 * document.removed events they were introduced for.
 *
 * @param {Object} delta
 * @param {*} delta.context   context selector (link) or path array (unlink)
 * @param {*} delta.directory directory selector (link) or path array (unlink)
 * @param {string[]} delta.features feature/attribute bitmap keys
 * @param {Object} [legacy] the deprecated alias block for this event family
 */
function membershipDelta({ context = null, directory = null, features = null } = {}, legacy = {}) {
    return {
        changed: {
            context: selectorPaths(context),
            directory: selectorPaths(directory),
            features: Array.isArray(features) ? features : [],
        },
        ...legacy,
    };
}

export {
    EVENTS,
    SynapsDEvent,
    createEvent,
    createTreeEvent,
    DOCUMENT_EVENT_REASONS,
    ENVELOPE_INPUT_KEYS,
    membershipDelta,
    selectorPaths,
};
