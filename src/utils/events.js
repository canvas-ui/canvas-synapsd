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
    DOCUMENT_INSERTED: 'document.inserted',
    DOCUMENT_UPDATED:  'document.updated',
    DOCUMENT_REMOVED:  'document.removed',
    DOCUMENT_DELETED:  'document.deleted',
    // Membership changes as first-class events. link/unlink ALSO emit
    // document.updated / document.removed (membership-only payloads) for
    // consumers that predate these names; linked/unlinked carry the full
    // document so automation (workspace hooks/rules) can match on content.
    DOCUMENT_LINKED:   'document.linked',
    DOCUMENT_UNLINKED: 'document.unlinked',
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
class SynapsDEvent {
    constructor(event, detail = {}, source = 'db') {
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

export { EVENTS, SynapsDEvent, createEvent, createTreeEvent };
