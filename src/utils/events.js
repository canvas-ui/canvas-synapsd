'use strict';

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
 *     source:    string,   // originator: 'db' | 'tree' | caller-provided
 *     timestamp: string,   // ISO 8601
 *     treeId:    ?string,  // present on tree-scoped events
 *     treeName:  ?string,
 *     treeType:  ?string,
 *     ...detail            // event-specific fields
 *   }
 */
class SynapsDEvent {
    constructor(event, detail = {}, source = 'db') {
        this.event = event;
        this.source = detail.source ?? source;
        this.timestamp = detail.timestamp ?? new Date().toISOString();
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
