import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Canvas from './Canvas.js';

describe('Canvas layer', () => {
    test('normalizes saved search query in querySpec', () => {
        const canvas = new Canvas({ name: 'project-foo', querySpec: { q: '  Project FOO  ' } });

        assert.equal(canvas.querySpec.query, 'Project FOO');
    });
});
