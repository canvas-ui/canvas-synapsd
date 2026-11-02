import { expect, test } from '@jest/globals';
import { parseInitializeDocument } from '../src/utils/document.js';

test('JSON object payloads normalize before schema construction without changing the input', () => {
    const input = { schema: 'data/schema/note', data: '{"title":"carmack insert probe","content":"test"}' };
    const document = parseInitializeDocument(input);
    expect(document.data).toEqual({ title: 'carmack insert probe', content: 'test' });
    expect(typeof input.data).toBe('string');
    const task = parseInitializeDocument({ schema: 'data/schema/task', data: '{"title":"Deadline","dueDate":"2026-11-07"}' });
    expect(task.timelines).toEqual([{ timeline: 'tasks', start: task.data.dueDate }]);
    expect(task.data.dueDate).toMatch(/T.*Z$/);
});

test('invalid payloads carry structured field errors, including JSON-encoded non-objects', () => {
    for (const data of [null, [], 42, undefined, 'null', '[]', '42', '"text"', '{broken']) {
        let error;
        try { parseInitializeDocument({ schema: 'data/schema/note', data }); } catch (caught) { error = caught; }
        expect(error?.code).toBe('INVALID_DOCUMENT');
        expect(error.statusCode).toBe(400);
        expect(error.details.schema).toBe('data/schema/note');
        expect(error.details.issues[0].path).toEqual(['data']);
        expect(error.message).toMatch(/^data /);
    }
    expect(() => parseInitializeDocument({ data: {} })).toThrow('schema must be a non-empty string (got undefined)');
});
