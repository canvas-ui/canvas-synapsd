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

    const tab = TabSchema.fromData({
        data: {
            url: 'https://example.com',
            title: 'Example Tab',
        }
    });

    const tab2 = TabSchema.fromData({
        data: {
            url: 'https://example2.com',
            title: 'Example Tab2',
        }
    });

    const tree = db.tree;
    console.log(tree.paths);

    //const result = await db.insertDocument(tab, '/foo/bar/baz', ['client/os/linux', 'client/browser/chrome']);
    //const result2 = await db.insertDocument(tab2, '/foo/baf', ['client/os/windows', 'client/browser/firefox']);
    const treeResult = await tree.insertDocument(tab, '/newpath', ['client/os/macos']);
    console.log(treeResult);

    /*
    console.log(await db.findDocuments('/foo', ['client/browser/firefox']));
    console.log(await db.findDocuments('/foo/bar/baz'));
    console.log(await db.findDocuments('/foo/baf'));*/

    console.log(await db.findDocuments('/newpath'));


}

test();
