import { afterEach, describe, expect, test } from '@jest/globals';

import schemaRegistry from '../src/schemas/SchemaRegistry.js';
import BaseDocument from '../src/schemas/BaseDocument.js';
import Document from '../src/schemas/abstractions/Document.js';
import Device from '../src/schemas/abstractions/Device.js';
import Identity from '../src/schemas/abstractions/Identity.js';
import Message from '../src/schemas/abstractions/Message.js';
import Todo from '../src/schemas/abstractions/Todo.js';
import { facetBitmapKeysForTest } from '../src/index.js';

// The v3 core entity set. Ids stay `data/abstraction/*` under D1(c) — the model
// changes, the id rename is deferred to its own rev — so these strings are
// load-bearing and NOT a sweep target.
const CORE_IDS = [
    'data/abstraction/document',
    'data/abstraction/file',
    'data/abstraction/message',
    'data/abstraction/email',
    'data/abstraction/todo',
    'data/abstraction/identity',
    'data/abstraction/device',
    'data/abstraction/application',
];

const APP_IDS = [
    'data/abstraction/note',
    'data/abstraction/tab',
    'data/abstraction/link',
    'data/abstraction/dotfile',
];

class Widget extends BaseDocument {
    constructor(options = {}) {
        options.schema = options.schema || 'data/abstraction/widget';
        super(options);
    }
}

describe('SchemaRegistry v3', () => {
    afterEach(() => {
        // registerSchema mutates a singleton; leaking a registration would make
        // sibling tests order-dependent.
        try { schemaRegistry.unregisterSchema('data/abstraction/widget'); } catch { /* not registered */ }
    });

    describe('core set', () => {
        test('every core id resolves to a BaseDocument subclass', () => {
            for (const id of CORE_IDS) {
                expect(schemaRegistry.hasSchema(id)).toBe(true);
                const SchemaClass = schemaRegistry.getSchema(id);
                expect(SchemaClass.prototype instanceof BaseDocument || SchemaClass === BaseDocument).toBe(true);
                expect(schemaRegistry.getSchemaEntry(id).tier).toBe('core');
            }
        });

        test('message is registered — getSchema on it used to throw while the parent chat service wrote it', () => {
            expect(() => schemaRegistry.getSchema('data/abstraction/message')).not.toThrow();
            expect(schemaRegistry.getSchema('data/abstraction/message')).toBe(Message);
        });

        test('contact and bucket ids are gone', () => {
            expect(schemaRegistry.hasSchema('data/abstraction/contact')).toBe(false);
            expect(schemaRegistry.hasSchema('data/abstraction/bucket')).toBe(false);
            expect(() => schemaRegistry.getSchema('data/abstraction/contact')).toThrow(/Schema not found/);
        });

        test('contact is replaced by identity', () => {
            expect(schemaRegistry.getSchema('data/abstraction/identity')).toBe(Identity);
        });

        test("the 'BaseDocument' alias is gone", () => {
            expect(schemaRegistry.hasSchema('BaseDocument')).toBe(false);
        });

        test('document is stamped 3.0 — it used to validate against 2.2 while stamping 2.0', () => {
            const doc = new Document({ schema: 'data/abstraction/document', data: { title: 'x' } });
            expect(doc.schemaVersion).toBe('3.0');
        });

        test('app-level schemas are registered but marked as such', () => {
            for (const id of APP_IDS) {
                expect(schemaRegistry.getSchemaEntry(id).tier).toBe('app');
            }
        });
    });

    describe('registerSchema', () => {
        test('round-trips an app schema through the public API', () => {
            expect(schemaRegistry.hasSchema('data/abstraction/widget')).toBe(false);

            schemaRegistry.registerSchema('data/abstraction/widget', Widget, { kind: 'widget' });

            expect(schemaRegistry.getSchema('data/abstraction/widget')).toBe(Widget);
            expect(schemaRegistry.listSchemas('data/')).toContain('data/abstraction/widget');
            expect(schemaRegistry.getSchemaEntry('data/abstraction/widget').tier).toBe('app');

            expect(schemaRegistry.unregisterSchema('data/abstraction/widget')).toBe(true);
            expect(schemaRegistry.hasSchema('data/abstraction/widget')).toBe(false);
        });

        test('carries indexOptions on the registration, not the row', () => {
            schemaRegistry.registerSchema('data/abstraction/widget', Widget, {
                indexOptions: { ftsSearchFields: ['data.label'] },
            });
            expect(schemaRegistry.getSchemaEntry('data/abstraction/widget').indexOptions)
                .toEqual({ ftsSearchFields: ['data.label'] });
        });

        test('core ids are sealed against re-registration and removal', () => {
            expect(() => schemaRegistry.registerSchema('data/abstraction/file', Widget))
                .toThrow(/core schema and cannot be re-registered/);
            expect(() => schemaRegistry.unregisterSchema('data/abstraction/file'))
                .toThrow(/core schema and cannot be removed/);
            // ...and the core registration is untouched by the failed attempt.
            expect(schemaRegistry.getSchema('data/abstraction/file')).not.toBe(Widget);
        });

        test('rejects a non-BaseDocument class', () => {
            class NotADocument {}
            expect(() => schemaRegistry.registerSchema('data/abstraction/widget', NotADocument))
                .toThrow(/must be registered with a BaseDocument subclass/);
            expect(() => schemaRegistry.registerSchema('data/abstraction/widget', { dataSchema: {} }))
                .toThrow(/must be registered with a BaseDocument subclass/);
        });

        test('rejects an empty id', () => {
            expect(() => schemaRegistry.registerSchema('', Widget)).toThrow(/non-empty string/);
            expect(() => schemaRegistry.registerSchema('   ', Widget)).toThrow(/non-empty string/);
        });

        test('rejects declaring both a literal kind and a kindField', () => {
            expect(() => schemaRegistry.registerSchema('data/abstraction/widget', Widget, {
                kind: 'widget', kindField: 'data.type',
            })).toThrow(/one kind axis/);
        });
    });

    // The generic-engine goal: a consumer registers its own abstraction by
    // extending BaseDocument or a core schema, declares its OWN fts/vector fields
    // per SCHEMA (never per write), and still gets the base mandatory fields
    // enforced. This is class inheritance doing the work — `static indexOptions`
    // resolves through the prototype chain, so BaseDocument finds it via
    // `this.constructor` with no registry import and therefore no import cycle.
    describe('consumer-registered abstraction extending a core schema', () => {
        class Phone extends Device {
            static indexOptions = {
                ftsSearchFields: ['data.maker', 'data.hwRelease'],
                vectorEmbeddingFields: ['data.maker'],
                checksumFields: ['data.deviceId'],
            };

            constructor(options = {}) {
                options.schema = options.schema || 'data/abstraction/phone';
                super(options);
            }
        }

        // Declares nothing of its own — must inherit its parent's configuration.
        class Tablet extends Device {
            constructor(options = {}) {
                options.schema = options.schema || 'data/abstraction/tablet';
                super(options);
            }
        }

        afterEach(() => {
            for (const id of ['data/abstraction/phone', 'data/abstraction/tablet']) {
                try { schemaRegistry.unregisterSchema(id); } catch { /* not registered */ }
            }
        });

        test('a subclass declares its own index fields per schema, not per write', () => {
            schemaRegistry.registerSchema('data/abstraction/phone', Phone, { kind: 'phone' });

            const phone = new Phone({ data: { deviceId: 'p1', name: 'Pixel', maker: 'Google', hwRelease: '2024' } });

            expect(phone.indexOptions.ftsSearchFields).toEqual(['data.maker', 'data.hwRelease']);
            expect(phone.generateFtsData()).toEqual(['Google', '2024']);
            expect(schemaRegistry.getSchema('data/abstraction/phone')).toBe(Phone);
        });

        test('a subclass declaring none inherits its parent index options', () => {
            schemaRegistry.registerSchema('data/abstraction/tablet', Tablet);

            const tablet = new Tablet({ data: { deviceId: 't1', name: 'Tab' } });
            expect(tablet.indexOptions.ftsSearchFields).toEqual(Device.indexOptions.ftsSearchFields);
        });

        test('base mandatory fields stay enforced on the subclass', () => {
            // Device requires data.deviceId; a consumer subclass cannot opt out of
            // its parent's contract by registering.
            expect(() => Phone.validateData({
                schema: 'data/abstraction/phone',
                data: { name: 'no deviceId' },
            })).toThrow();
        });

        test('a registered subclass is still a BaseDocument', () => {
            const phone = new Phone({ data: { deviceId: 'p1', name: 'Pixel' } });
            expect(phone instanceof BaseDocument).toBe(true);
            expect(phone instanceof Device).toBe(true);
        });
    });

    describe('resolveKind', () => {
        test('returns a literal kind', () => {
            expect(schemaRegistry.resolveKind('data/abstraction/tab')).toBe('browser/tab');
            expect(schemaRegistry.resolveKind('data/abstraction/note')).toBe('note');
        });

        test('reads a kindField off the document, always under the entity prefix', () => {
            // Decided 2026-08-03: kindField values are ALWAYS prefixed with the
            // entity. Bare 'flatpak'/'person' would be unfixable if another schema
            // later claimed the same value — bitmap keys are append-only.
            expect(schemaRegistry.resolveKind('data/abstraction/application', { data: { type: 'flatpak' } }))
                .toBe('application/flatpak');
            expect(schemaRegistry.resolveKind('data/abstraction/identity', { data: { type: 'person' } }))
                .toBe('identity/person');
        });

        test('a kindField registration without a kindPrefix is refused', () => {
            expect(() => schemaRegistry.registerSchema('data/abstraction/widget', Widget, {
                kindField: 'data.type',
            })).toThrow(/kindField without kindPrefix/);
        });

        test('prefixed values are hierarchical, so the parent segment is a roll-up query', () => {
            // A dotfile can be a directory — the file-vs-folder axis is a kind, not
            // a second entity, and the parent segment makes "any dotfile" one key.
            expect(schemaRegistry.resolveKind('data/abstraction/dotfile', { data: { type: 'folder' } }))
                .toBe('dotfile/folder');
            expect(schemaRegistry.resolveKind('data/abstraction/dotfile', { data: { type: 'file' } }))
                .toBe('dotfile/file');
        });

        test('returns null when the schema declares no kind axis, or the field is absent', () => {
            expect(schemaRegistry.resolveKind('data/abstraction/file')).toBeNull();
            expect(schemaRegistry.resolveKind('data/abstraction/application', {})).toBeNull();
            expect(schemaRegistry.resolveKind('data/abstraction/application', { data: {} })).toBeNull();
            expect(schemaRegistry.resolveKind('data/abstraction/application', { data: { type: '' } })).toBeNull();
            expect(schemaRegistry.resolveKind('data/abstraction/nonexistent')).toBeNull();
        });
    });

    describe('Identity', () => {
        test('carries a type discriminator, not a data-level kind that would shadow the row field', () => {
            const identity = Identity.fromData({ data: { displayName: 'Alice', type: 'person' } });
            expect(identity.data.type).toBe('person');
            expect(identity.schema).toBe('data/abstraction/identity');
            expect(identity.schemaVersion).toBe('3.0');
        });

        test('identifiers are a field on the identity, not the identity itself', () => {
            const identity = Identity.fromData({ data: { displayName: 'Alice' } });
            identity.addIdentifier({ type: 'email', identifier: 'alice@example.com', primary: true });
            identity.addIdentifier({ type: 'slack', identifier: 'U123' });

            expect(identity.data.identifiers).toHaveLength(2);
            expect(identity.primaryIdentifier.identifier).toBe('alice@example.com');

            identity.removeIdentifier({ type: 'slack' });
            expect(identity.data.identifiers).toHaveLength(1);
        });

        test('rejects the retired contact enum values', () => {
            expect(() => Identity.validateData({
                schema: 'data/abstraction/identity',
                data: { displayName: 'Team', type: 'team' },
            })).toThrow();
        });
    });
});

// Facet fields: data/<leaf-field>/<value>, generalized 2026-08-03 from a status
// axis that was hardcoded to todo. A consumer abstraction gets the machinery by
// declaring it on the class — same pattern as indexOptions and mergeOnDedupe.
describe('facetFields', () => {
    test('todo declares its own status facet instead of the engine hardcoding it', () => {
        expect(Todo.facetFields).toEqual(['data.status']);
    });

    test('engine-owned namespaces are refused, so a schema cannot write the derived axes', () => {
        class Sneaky extends BaseDocument {
            static facetFields = ['data.kind', 'data.mime', 'data.backend', 'data.colour'];
            constructor(options = {}) {
                options.schema = options.schema || 'data/abstraction/sneaky';
                super(options);
            }
        }

        const doc = new Sneaky({ data: { kind: 'pwned', mime: 'pwned', backend: 'pwned', colour: 'red' } });
        const keys = facetBitmapKeysForTest(doc);

        expect(keys).toContain('data/colour/red');
        for (const key of keys) {
            expect(key.startsWith('data/kind/')).toBe(false);
            expect(key.startsWith('data/mime/')).toBe(false);
            expect(key.startsWith('data/backend/')).toBe(false);
        }
    });
});
