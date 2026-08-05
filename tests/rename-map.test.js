import { describe, expect, test } from '@jest/globals';

import schemaRegistry, { SCHEMA_ID_RENAMES } from '../src/schemas/SchemaRegistry.js';

// The Rev B old->new map is HISTORY the migration script executes. If it drifts
// from the registry — an entry pointing at an id nothing serves — the migration
// would rewrite rows to a schema the engine cannot construct.
describe('SCHEMA_ID_RENAMES', () => {
    test('covers exactly the 13 pre-Rev-B ids', () => {
        expect(Object.keys(SCHEMA_ID_RENAMES)).toHaveLength(13);
        for (const oldId of Object.keys(SCHEMA_ID_RENAMES)) {
            expect(oldId).toMatch(/^data\/abstraction\//);
        }
    });

    test('every target id is registered', () => {
        for (const newId of Object.values(SCHEMA_ID_RENAMES)) {
            expect(schemaRegistry.hasSchema(newId)).toBe(true);
        }
    });

    test('no registered data/schema id is missing from the map targets', () => {
        const targets = new Set(Object.values(SCHEMA_ID_RENAMES));
        for (const id of schemaRegistry.listSchemas('data/schema')) {
            expect(targets.has(id)).toBe(true);
        }
    });

    test('no old id remains registered', () => {
        for (const oldId of Object.keys(SCHEMA_ID_RENAMES)) {
            expect(schemaRegistry.hasSchema(oldId)).toBe(false);
        }
    });
});

// Registered vs derived two-segment ids: `message/email` is a registry entry,
// `application/flatpak` is a bitmap key only. getSchema() stays exact-match and
// must not silently resolve a derived key to the parent class (an unknown
// subtype would construct and validate as the parent). resolveSchemaId() is the
// explicit bridge for callers holding a bitmap key.
describe('derived-key resolution', () => {
    test('getSchema throws on a derived subtype key, naming the real schema', () => {
        expect(() => schemaRegistry.getSchema('data/schema/application/flatpak')).toThrow(
            /derived subtype bitmap key.*data\/schema\/application/,
        );
    });

    test('getSchema still reports plain not-found for unknown ids', () => {
        expect(() => schemaRegistry.getSchema('data/schema/nonexistent')).toThrow(/Schema not found/);
    });

    test('resolveSchemaId is identity on a registered id', () => {
        expect(schemaRegistry.resolveSchemaId('data/schema/message/email')).toBe('data/schema/message/email');
        expect(schemaRegistry.resolveSchemaId('data/schema/note')).toBe('data/schema/note');
    });

    test('resolveSchemaId walks a derived key to the registered ancestor', () => {
        expect(schemaRegistry.resolveSchemaId('data/schema/application/flatpak')).toBe('data/schema/application');
    });

    test('resolveSchemaId returns null when nothing registered is above the key', () => {
        expect(schemaRegistry.resolveSchemaId('data/unrelated/thing')).toBeNull();
        expect(schemaRegistry.resolveSchemaId('')).toBeNull();
    });
});
