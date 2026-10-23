'use strict';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/backends/lmdb/index.js';

describe('lmdb wrapper: writes racing close()', () => {
    let rootPath;
    let uncaught;
    const onUncaught = (error) => { uncaught.push(error); };

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-lmdb-close-'));
        uncaught = [];
        process.on('uncaughtException', onUncaught);
    });

    afterEach(async () => {
        process.off('uncaughtException', onUncaught);
        await fs.rm(rootPath, { recursive: true, force: true });
    });

    test('a dataset write issued after close() begins rejects instead of crashing in lmdb', async () => {
        const db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        const dataset = db.createDataset('tree');
        await dataset.put('a', 1);

        const closing = db.close();
        const late = dataset.put('b', 2);
        await expect(late).rejects.toMatchObject({ code: 'DB_CLOSED' });
        expect(() => dataset.putSync('c', 3)).toThrow('Database is closed');
        await expect(dataset.transaction(() => dataset.putSync('d', 4))).rejects.toMatchObject({ code: 'DB_CLOSED' });
        await closing;

        // lmdb would have thrown "The environment is already closed." from its
        // commit timer on the next turns.
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(uncaught).toEqual([]);
    });

    test('the root handle refuses writes once closing too', async () => {
        const db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        const closing = db.close();
        await expect(db.put('k', 'v')).rejects.toMatchObject({ code: 'DB_CLOSED' });
        await expect(db.remove('k')).rejects.toMatchObject({ code: 'DB_CLOSED' });
        await closing;
    });
});
