import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Workspace from '../../../core/workspace/Workspace.js';

const NOTE_SCHEMA = 'data/abstraction/note';

class MemoryConfig {
    constructor(seed = {}) {
        this.store = { ...seed };
    }

    get(key, fallback = undefined) {
        return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : fallback;
    }

    set(key, value) {
        this.store[key] = value;
    }
}

function note(title) {
    return {
        schema: NOTE_SCHEMA,
        data: { title, content: title },
    };
}

function ids(results) {
    return results.map((doc) => doc.id).sort((a, b) => a - b);
}

describe('Workspace query translation', () => {
    let rootPath;
    let workspace;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-synapsd-test-'));
        workspace = new Workspace({
            rootPath,
            configStore: new MemoryConfig({
                id: 'workspace-query-test',
                name: 'Workspace Query Test',
                services: { home: { enabled: false } },
            }),
            logger: {
                debug() {},
                info() {},
                warn() {},
                error() {},
            },
        });
        await workspace.start();
    });

    afterEach(async () => {
        if (workspace) {
            await workspace.stop();
            workspace = null;
        }
        if (rootPath) {
            await fs.rm(rootPath, { recursive: true, force: true });
            rootPath = null;
        }
    });

    test('translates attributes to synapsd features and forwards pagination options', async () => {
        const firstId = await workspace.put(note('first'), { attributes: ['tag/workspace'] });
        const secondId = await workspace.put(note('second'), { attributes: ['tag/workspace'] });
        await workspace.put(note('third'), { attributes: ['tag/other'] });

        expect(ids(await workspace.list({ attributes: { allOf: ['tag/workspace'] } }))).toEqual([firstId, secondId]);

        const page = await workspace.list({ attributes: { allOf: ['tag/workspace'] }, limit: 1, offset: 1 });
        expect(page).toHaveLength(1);
        expect(page[0].id).toBe(secondId);
        expect(page.totalCount).toBe(2);
    });

    test('composes canvas querySpec before delegating to synapsd', async () => {
        const tree = workspace.getDefaultContextTree();
        await tree.insertPath('/Saved', {
            leafType: 'canvas',
            querySpec: { features: { allOf: ['tag/canvas'] } },
        });

        const canvasDocId = await workspace.put(note('canvas match'), { attributes: ['tag/canvas'] });
        await workspace.put(note('canvas miss'), { attributes: ['tag/other'] });

        expect(ids(await workspace.list({ context: '/Saved' }))).toEqual([canvasDocId]);
    });
});
