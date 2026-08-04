import { describe, expect, test } from '@jest/globals';
import { z } from 'zod';

import Document from '../src/schemas/Document.js';
import Device from '../src/schemas/core/Device.js';
import Application from '../src/schemas/core/Application.js';

// Gap 1 of "consumer-registered abstractions": a subclass of a core schema
// inherited its parent's `dataSchema` unchanged, so the consumer's OWN fields were
// accepted by passthrough but never validated — and calling `extendDataSchema()`
// instead built a fresh wrapper that dropped the PARENT's field validation. Either
// way something went unchecked.
//
// The parent arrives as `super.dataSchema`, so this helper takes no `this` and does
// no prototype walking — see the note on the method.
describe('mergeDataSchema', () => {
    class Phone extends Device {
        static get dataSchema() {
            return Document.mergeDataSchema(super.dataSchema, { imei: z.string() });
        }
    }

    describe('merging an object-shaped parent', () => {
        const parse = (data) => Phone.dataSchema.safeParse({ schema: 'data/abstraction/phone', data });

        test('validates the parent fields AND the subclass fields', () => {
            expect(parse({ deviceId: 'p1', name: 'Pixel', imei: '123' }).success).toBe(true);

            // Parent's contract still enforced — a subclass cannot opt out of it.
            expect(parse({ imei: '123' }).success).toBe(false);
            // ...and the subclass's own field is now actually checked, which is the
            // whole gap: before this it was passthrough, so `imei: 42` sailed through.
            expect(parse({ deviceId: 'p1', name: 'Pixel', imei: 42 }).success).toBe(false);
        });

        test('unknown keys still pass through', () => {
            const result = parse({ deviceId: 'p1', name: 'Pixel', imei: '123', vendorExtra: 'kept' });
            expect(result.success).toBe(true);
            expect(result.data.data.vendorExtra).toBe('kept');
        });

        test('the parent envelope is carried over rather than restated', () => {
            expect(Object.keys(Phone.dataSchema.shape).sort())
                .toEqual(['data', 'metadata', 'schema', 'schemaVersion']);
        });

        test('the parent schema is untouched — merging returns a new schema', () => {
            expect(Device.dataSchema.safeParse({
                schema: 'data/abstraction/device',
                data: { deviceId: 'd1', name: 'Laptop' },
            }).success).toBe(true);
            expect(Device.dataSchema.shape.data.shape.imei).toBeUndefined();
        });
    });

    test('a z.record parent contributes no fields, so the subclass shape stands alone', () => {
        // Base `Document` types `data` as z.record(z.any()) — there is nothing named
        // to inherit. This is exactly why the existing `extendDataSchema()` was left
        // alone: making IT merge would change behaviour for every current caller.
        class Widget extends Document {
            static get dataSchema() {
                return Document.mergeDataSchema(super.dataSchema, { label: z.string() });
            }
        }

        expect(Widget.dataSchema.safeParse({ schema: 'x', data: { label: 'a', anything: 1 } }).success).toBe(true);
        expect(Widget.dataSchema.safeParse({ schema: 'x', data: { label: 9 } }).success).toBe(false);
    });

    test('refuses a parent wrapped in .refine() instead of silently dropping the rule', () => {
        // Application's dataSchema is a ZodEffects (cross-field refinement). It has
        // no introspectable shape, so rebuilding the object around it would leave the
        // subclass with WEAKER validation than its parent — fail loudly instead.
        class Flatpak extends Application {
            static get dataSchema() {
                return Document.mergeDataSchema(super.dataSchema, { ref: z.string() });
            }
        }

        expect(() => Flatpak.dataSchema).toThrow(/not a plain object schema/);
    });

    test('rejects a non-object extension shape', () => {
        expect(() => Document.mergeDataSchema(Device.dataSchema, z.string()))
            .toThrow(/must be an object shape/);
    });

    test('is a pure function — no `this`, so it works detached', () => {
        // The point of taking the parent as an argument: no prototype walking, no
        // binding to fool. A bare reference behaves identically to a method call.
        const { mergeDataSchema } = Document;
        const merged = mergeDataSchema(Device.dataSchema, { imei: z.string() });

        expect(merged.safeParse({ schema: 'x', data: { deviceId: 'p1', name: 'P', imei: '1' } }).success).toBe(true);
        expect(merged.safeParse({ schema: 'x', data: { deviceId: 'p1', name: 'P', imei: 1 } }).success).toBe(false);
    });
});
