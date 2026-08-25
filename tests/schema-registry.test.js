import { afterEach, describe, expect, test } from '@jest/globals';

import schemaRegistry from '../src/schemas/SchemaRegistry.js';
import Document from '../src/schemas/Document.js';
import Device from '../src/schemas/core/Device.js';
import Identity from '../src/schemas/core/Identity.js';
import Message from '../src/schemas/core/Message.js';
import Task from '../src/schemas/core/Task.js';
import { facetBitmapKeysForTest } from '../src/index.js';

// The v3 core entity set. Ids stay `data/schema/*` under D1(c) — the model
// changes, the id rename is deferred to its own rev — so these strings are
// load-bearing and NOT a sweep target.
const CORE_IDS = [
    'data/schema/document',
    'data/schema/file',
    'data/schema/message',
    'data/schema/message/email',
    'data/schema/event',
    'data/schema/task',
    'data/schema/identity',
    'data/schema/device',
    'data/schema/application',
];

const APP_IDS = [
    'data/schema/note',
    'data/schema/tab',
    'data/schema/link',
    'data/schema/dotfile',
];

class Widget extends Document {
    constructor(options = {}) {
        options.schema = options.schema || 'data/schema/widget';
        super(options);
    }
}

describe('SchemaRegistry v3', () => {
    afterEach(() => {
        // registerSchema mutates a singleton; leaking a registration would make
        // sibling tests order-dependent.
        try { schemaRegistry.unregisterSchema('data/schema/widget'); } catch { /* not registered */ }
    });

    describe('core set', () => {
        test('every core id resolves to a Document subclass', () => {
            for (const id of CORE_IDS) {
                expect(schemaRegistry.hasSchema(id)).toBe(true);
                const SchemaClass = schemaRegistry.getSchema(id);
                expect(SchemaClass.prototype instanceof Document || SchemaClass === Document).toBe(true);
                expect(schemaRegistry.getSchemaEntry(id).tier).toBe('core');
            }
        });

        test('message is registered — getSchema on it used to throw while the parent chat service wrote it', () => {
            expect(() => schemaRegistry.getSchema('data/schema/message')).not.toThrow();
            expect(schemaRegistry.getSchema('data/schema/message')).toBe(Message);
        });

        test('contact and bucket ids are gone', () => {
            expect(schemaRegistry.hasSchema('data/schema/contact')).toBe(false);
            expect(schemaRegistry.hasSchema('data/schema/bucket')).toBe(false);
            expect(() => schemaRegistry.getSchema('data/schema/contact')).toThrow(/Schema not found/);
        });

        test('contact is replaced by identity', () => {
            expect(schemaRegistry.getSchema('data/schema/identity')).toBe(Identity);
        });

        test("the legacy 'BaseDocument' schema id is gone", () => {
            expect(schemaRegistry.hasSchema('BaseDocument')).toBe(false);
            expect(schemaRegistry.hasSchema('Document')).toBe(false);
        });

        // Rev A merged abstractions/Document.js into the base class, so the id
        // and the base now resolve to the same constructor. Asserted rather than
        // assumed: the merge is only safe while the base carries the abstraction's
        // schema id + version defaults.
        test('data/schema/document resolves to the base class itself', () => {
            expect(schemaRegistry.getSchema('data/schema/document')).toBe(Document);
        });

        test('document is stamped 3.0 — it used to validate against 2.2 while stamping 2.0', () => {
            const doc = new Document({ schema: 'data/schema/document', data: { title: 'x' } });
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
            expect(schemaRegistry.hasSchema('data/schema/widget')).toBe(false);

            schemaRegistry.registerSchema('data/schema/widget', Widget);

            expect(schemaRegistry.getSchema('data/schema/widget')).toBe(Widget);
            expect(schemaRegistry.listSchemas('data/')).toContain('data/schema/widget');
            expect(schemaRegistry.getSchemaEntry('data/schema/widget').tier).toBe('app');

            expect(schemaRegistry.unregisterSchema('data/schema/widget')).toBe(true);
            expect(schemaRegistry.hasSchema('data/schema/widget')).toBe(false);
        });

        test('carries indexOptions on the registration, not the row', () => {
            schemaRegistry.registerSchema('data/schema/widget', Widget, {
                indexOptions: { ftsSearchFields: ['data.label'] },
            });
            expect(schemaRegistry.getSchemaEntry('data/schema/widget').indexOptions)
                .toEqual({ ftsSearchFields: ['data.label'] });
        });

        test('core ids are sealed against re-registration and removal', () => {
            expect(() => schemaRegistry.registerSchema('data/schema/file', Widget))
                .toThrow(/core schema and cannot be re-registered/);
            expect(() => schemaRegistry.unregisterSchema('data/schema/file'))
                .toThrow(/core schema and cannot be removed/);
            // ...and the core registration is untouched by the failed attempt.
            expect(schemaRegistry.getSchema('data/schema/file')).not.toBe(Widget);
        });

        test('rejects a non-Document class', () => {
            class NotADocument {}
            expect(() => schemaRegistry.registerSchema('data/schema/widget', NotADocument))
                .toThrow(/must be registered with a Document subclass/);
            expect(() => schemaRegistry.registerSchema('data/schema/widget', { dataSchema: {} }))
                .toThrow(/must be registered with a Document subclass/);
        });

        test('rejects an empty id', () => {
            expect(() => schemaRegistry.registerSchema('', Widget)).toThrow(/non-empty string/);
            expect(() => schemaRegistry.registerSchema('   ', Widget)).toThrow(/non-empty string/);
        });

        test('child ids share the parent class', () => {
            expect(schemaRegistry.getSchema('data/schema/application/flatpak'))
                .toBe(schemaRegistry.getSchema('data/schema/application'));
            expect(schemaRegistry.getSchema('data/schema/event/calendar'))
                .toBe(schemaRegistry.getSchema('data/schema/event'));
            expect(schemaRegistry.getSchema('data/schema/identity/person'))
                .toBe(schemaRegistry.getSchema('data/schema/identity'));
            expect(schemaRegistry.getSchema('data/schema/dotfile/file'))
                .toBe(schemaRegistry.getSchema('data/schema/dotfile'));
        });
    });

    // The generic-engine goal: a consumer registers its own abstraction by
    // extending Document or a core schema, declares its OWN fts/vector fields
    // per SCHEMA (never per write), and still gets the base mandatory fields
    // enforced. This is class inheritance doing the work — `static indexOptions`
    // resolves through the prototype chain, so Document finds it via
    // `this.constructor` with no registry import and therefore no import cycle.
    describe('consumer-registered abstraction extending a core schema', () => {
        class Phone extends Device {
            static indexOptions = {
                ftsSearchFields: ['data.maker', 'data.hwRelease'],
                vectorEmbeddingFields: ['data.maker'],
                checksumFields: ['data.deviceId'],
            };

            constructor(options = {}) {
                options.schema = options.schema || 'data/schema/phone';
                super(options);
            }
        }

        // Declares nothing of its own — must inherit its parent's configuration.
        class Tablet extends Device {
            constructor(options = {}) {
                options.schema = options.schema || 'data/schema/tablet';
                super(options);
            }
        }

        afterEach(() => {
            for (const id of ['data/schema/phone', 'data/schema/tablet']) {
                try { schemaRegistry.unregisterSchema(id); } catch { /* not registered */ }
            }
        });

        test('a subclass declares its own index fields per schema, not per write', () => {
            schemaRegistry.registerSchema('data/schema/phone', Phone, {});

            const phone = new Phone({ data: { deviceId: 'p1', name: 'Pixel', maker: 'Google', hwRelease: '2024' } });

            expect(phone.indexOptions.ftsSearchFields).toEqual(['data.maker', 'data.hwRelease']);
            expect(phone.generateFtsData()).toEqual(['Google', '2024']);
            expect(schemaRegistry.getSchema('data/schema/phone')).toBe(Phone);
        });

        test('a subclass declaring none inherits its parent index options', () => {
            schemaRegistry.registerSchema('data/schema/tablet', Tablet);

            const tablet = new Tablet({ data: { deviceId: 't1', name: 'Tab' } });
            expect(tablet.indexOptions.ftsSearchFields).toEqual(Device.indexOptions.ftsSearchFields);
        });

        test('base mandatory fields stay enforced on the subclass', () => {
            // Device requires data.deviceId; a consumer subclass cannot opt out of
            // its parent's contract by registering.
            expect(() => Phone.validateData({
                schema: 'data/schema/phone',
                data: { name: 'no deviceId' },
            })).toThrow();
        });

        test('a registered subclass is still a Document', () => {
            const phone = new Phone({ data: { deviceId: 'p1', name: 'Pixel' } });
            expect(phone instanceof Document).toBe(true);
            expect(phone instanceof Device).toBe(true);
        });
    });

    describe('retired kind/subtypeField axis', () => {
        test('the v3 kind resolver and subtypeField are gone, not aliased', () => {
            expect(schemaRegistry.resolveKind).toBeUndefined();
            expect(schemaRegistry.resolveSubtype).toBeUndefined();
            for (const id of schemaRegistry.listSchemas('data/')) {
                const entry = schemaRegistry.getSchemaEntry(id);
                expect(entry.kind).toBeUndefined();
                expect(entry.kindField).toBeUndefined();
                expect(entry.kindPrefix).toBeUndefined();
                expect(entry.subtypeField).toBeUndefined();
            }
        });
    });

    describe('Identity', () => {
        test('the type lives in the schema id, not a payload discriminator', () => {
            const identity = Identity.fromData({
                schema: 'data/schema/identity/person',
                data: { displayName: 'Alice' },
            });
            expect(identity.data.type).toBeUndefined();
            expect(identity.type).toBe('person');
            expect(identity.schema).toBe('data/schema/identity/person');
            expect(identity.schemaVersion).toBe('3.0');
        });

        test('the parent id is still writable (type was always optional)', () => {
            const identity = Identity.fromData({ data: { displayName: 'Alice' } });
            expect(identity.type).toBeNull();
            expect(identity.schema).toBe('data/schema/identity');
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

        test('rejects a leaf that is not in the identity enum', () => {
            expect(() => Identity.fromData({
                schema: 'data/schema/identity/team',
                data: { displayName: 'Team' },
            })).toThrow(/identity\/\{person\|organization\|service\|bot\}/);
        });
    });
});

// Facet fields: data/<leaf-field>/<value>, generalized 2026-08-03 from a status
// axis that was hardcoded to todo. A consumer abstraction gets the machinery by
// declaring it on the class — same pattern as indexOptions and mergeOnDedupe.
describe('facetFields', () => {
    test('todo declares its own status facet instead of the engine hardcoding it', () => {
        expect(Task.facetFields).toEqual(['data.status']);
    });

    test('engine-owned namespaces are refused, so a schema cannot write the derived axes', () => {
        class Sneaky extends Document {
            static facetFields = ['data.kind', 'data.mime', 'data.backend', 'data.schema', 'data.colour'];
            constructor(options = {}) {
                options.schema = options.schema || 'data/schema/sneaky';
                super(options);
            }
        }

        const doc = new Sneaky({
            data: { kind: 'pwned', mime: 'pwned', backend: 'pwned', schema: 'pwned', colour: 'red' },
        });
        const keys = facetBitmapKeysForTest(doc);

        expect(keys).toContain('data/colour/red');
        for (const key of keys) {
            expect(key.startsWith('data/kind/')).toBe(false);
            expect(key.startsWith('data/mime/')).toBe(false);
            expect(key.startsWith('data/backend/')).toBe(false);
            // `schema` is reserved AHEAD of `data/schema/*` existing: Rev B renames
            // `data/schema/*` to it, and a consumer facet squatting the
            // namespace meanwhile would land inside the identity axis on the day
            // the rename ships.
            expect(key.startsWith('data/schema/')).toBe(false);
        }
    });
});

// `jsonSchema` used to be hand-written per class as an EXAMPLE object
// (`{ schema, data: { title: 'string' } }`) — no enum, no required/optional, no
// range. Consumers could not learn anything from it, so they copied the facts
// instead (the web ui still mirrors the task status list by hand). It is now
// DERIVED from the same zod `dataSchema` validation uses, so the two cannot drift.
describe('jsonSchema derivation', () => {
    test('carries the enum a consumer would otherwise hand-copy', () => {
        const data = Task.jsonSchema.properties.data;

        expect(data.properties.status.enum).toEqual([
            'pending', 'in-progress', 'completed', 'cancelled',
        ]);
        // The RFC 5545 priority scale — invisible in the old stub.
        expect(data.properties.priority).toMatchObject({ type: 'integer', minimum: 1, maximum: 9 });
        // Required-vs-optional falls out of `.optional()`, so a form builder can
        // render it without knowing anything about synapsd.
        expect(data.required).toEqual(['title']);
        expect(Identity.jsonSchema.properties.data.properties.type).toBeUndefined();
    });

    test('every registered document schema converts, and layer types return null', () => {
        for (const id of schemaRegistry.listSchemas()) {
            const derived = schemaRegistry.getJsonSchema(id);

            if (id.startsWith('internal/layers/')) {
                // Layer classes are not documents and carry no zod data schema.
                // Explicitly null rather than a throw, so listing every schema is safe.
                expect(derived).toBeNull();
                continue;
            }

            expect(derived.$schema).toBe('http://json-schema.org/draft-07/schema#');
            expect(derived.type).toBe('object');
            // $id is stamped by the REGISTRY (the class does not know its id).
            expect(derived.$id).toBe(id);
        }
    });

    test('subclasses inherit the derivation instead of overriding it', () => {
        // `this` in the static getter is the class it was accessed on, so each
        // subclass converts its OWN dataSchema. A subclass that reintroduced a
        // hand-written stub would fail here: stubs have no $schema.
        for (const SchemaClass of [Document, Task, Device, Identity, Message]) {
            expect(SchemaClass.jsonSchema.$schema).toBe('http://json-schema.org/draft-07/schema#');
        }
        // Document declares the getter; nothing else may. An own `jsonSchema` on a
        // subclass means someone put a stub back.
        for (const SchemaClass of [Task, Device, Identity, Message]) {
            expect(Object.getOwnPropertyDescriptor(SchemaClass, 'jsonSchema')).toBeUndefined();
        }
        expect(Task.jsonSchema).not.toEqual(Device.jsonSchema);
    });

    test('conversion is memoized per class — it is served on a public route', () => {
        expect(Task.jsonSchema).toBe(Task.jsonSchema);
        expect(Task.jsonSchema).not.toBe(Device.jsonSchema);
    });
});
