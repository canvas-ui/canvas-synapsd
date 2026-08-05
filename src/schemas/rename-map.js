'use strict';

/**
 * The Rev B id rename, written ONCE (TODO.md: "Write the old->new map ONCE, as an
 * exported constant, and let the consumers import it where they can").
 *
 * `data/abstraction/*` (flat, one segment) became hierarchical `data/schema/*`
 * (2026-08-05). Two ids did more than move namespace:
 *   - email  -> message/email  (hierarchy adoption: an email IS a message, so the
 *     id carries the parent segment and the bitmap plane ticks both)
 *   - todo   -> task           (the class was renamed in Rev A; this finishes the id)
 *
 * Consumed by scripts/migrate-schema-v3.js to rewrite rows, and importable by any
 * consumer that needs to translate stored references. This map is HISTORY, not
 * configuration — it never grows except with a future coordinated rename, and it
 * must keep mapping onto ids the registry actually serves (guarded by tests).
 */
export const SCHEMA_ID_RENAMES = Object.freeze({
    'data/abstraction/document':    'data/schema/document',
    'data/abstraction/file':        'data/schema/file',
    'data/abstraction/message':     'data/schema/message',
    'data/abstraction/email':       'data/schema/message/email',
    'data/abstraction/event':       'data/schema/event',
    'data/abstraction/todo':        'data/schema/task',
    'data/abstraction/identity':    'data/schema/identity',
    'data/abstraction/device':      'data/schema/device',
    'data/abstraction/application': 'data/schema/application',
    'data/abstraction/note':        'data/schema/note',
    'data/abstraction/tab':         'data/schema/tab',
    'data/abstraction/link':        'data/schema/link',
    'data/abstraction/dotfile':     'data/schema/dotfile',
});

export default SCHEMA_ID_RENAMES;
