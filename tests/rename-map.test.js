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

    test('every registered data/schema id is a map target, a child of one, or born post-Rev-B', () => {
        // Schemas introduced AFTER the Rev B rename have no old id to map from
        // — list them here so the guard keeps catching accidental drift while
        // allowing the registry to grow.
        const POST_REV_B = new Set([
            'data/schema/drawing', // 2026-09-02, sketch editor
        ]);
        const targets = [...Object.values(SCHEMA_ID_RENAMES)];
        for (const id of schemaRegistry.listSchemas('data/schema')) {
            if (POST_REV_B.has(id)) continue;
            expect(targets.some((t) => id === t || id.startsWith(`${t}/`))).toBe(true);
        }
    });

    test('no old id remains registered', () => {
        for (const oldId of Object.keys(SCHEMA_ID_RENAMES)) {
            expect(schemaRegistry.hasSchema(oldId)).toBe(false);
        }
    });
});

// Closed-enum children are registered and share the parent class. getSchema()
// stays exact-match: an unknown extra segment must not silently construct as
// the parent. resolveSchemaId() is the explicit ancestor walk for bitmap keys.
describe('derived-key resolution', () => {
    test('getSchema returns the parent class for a registered child', () => {
        expect(schemaRegistry.getSchema('data/schema/application/flatpak'))
            .toBe(schemaRegistry.getSchema('data/schema/application'));
    });

    test('getSchema throws on an unknown extra segment, naming the nearest schema', () => {
        expect(() => schemaRegistry.getSchema('data/schema/application/not-a-type')).toThrow(
            /not a registered schema id — nearest schema is data\/schema\/application/,
        );
    });

    test('getSchema still reports plain not-found for unknown ids', () => {
        expect(() => schemaRegistry.getSchema('data/schema/nonexistent')).toThrow(/Schema not found/);
    });

    test('resolveSchemaId is identity on a registered id, including children', () => {
        expect(schemaRegistry.resolveSchemaId('data/schema/message/email')).toBe('data/schema/message/email');
        expect(schemaRegistry.resolveSchemaId('data/schema/application/flatpak')).toBe('data/schema/application/flatpak');
        expect(schemaRegistry.resolveSchemaId('data/schema/note')).toBe('data/schema/note');
    });

    test('resolveSchemaId walks an unregistered extra segment to the registered ancestor', () => {
        expect(schemaRegistry.resolveSchemaId('data/schema/application/not-a-type')).toBe('data/schema/application');
    });

    test('resolveSchemaId returns null when nothing registered is above the key', () => {
        expect(schemaRegistry.resolveSchemaId('data/unrelated/thing')).toBeNull();
        expect(schemaRegistry.resolveSchemaId('')).toBeNull();
    });
});
