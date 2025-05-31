'use strict';

import SynapsD from '../src/index.js';

// Use the same DB path as _test.js to potentially reuse data/layers
const DB_PATH = '/tmp/synapsd-testdb';

const db = new SynapsD({
    path: DB_PATH
});

async function test() {

    await db.start();
    const schemas = db.listSchemas('data');
    const TabSchema = db.getSchema('data/abstraction/tab');

    for (let i = 0; i < 100; i++) {
        const tab = TabSchema.fromData({
            data: {
                url: `https://example.com/${i}`,
                title: `Example Tab ${i}`,
            }
        });
        await db.insertDocument(tab, '/test/path', ['client/os/linux', 'client/browser/chrome']);
    }

    console.log(await db.findDocuments('/test/path'));

    console.log(await db.findDocuments('/test/path', ['custom/tag/foo']));

    console.log(await db.hasDocument(100100));

    console.log(await db.hasDocument(100100, '/z', ['client/os/linux', 'client/browser/chrome']));


    console.log('--------------------------------');
    console.log(await db.removeDocument(100100, '/test/path'));
    console.log(await db.hasDocument(100100, '/test/path'));
    console.log(await db.hasDocument(100100, '/test'));
    await db.stop();

}

test();
