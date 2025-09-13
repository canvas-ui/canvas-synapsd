'use strict';

import path from 'path';
import fs from 'fs';
import SynapsD from '../src/index.js';

async function main() {
    const rootPath = path.resolve(process.cwd(), 'tmp/test-synapsd-fts');
    fs.mkdirSync(rootPath, { recursive: true });

    const db = new SynapsD({ path: rootPath });
    await db.start();

    // Insert a few notes
    const context = '/';
    const features = ['data/abstraction/note'];

    const notes = [
        { schema: 'data/abstraction/note', data: { title: 'Shopping list', content: 'milk bread apples bananas' } },
        { schema: 'data/abstraction/note', data: { title: 'Meeting notes', content: 'discuss vector search lance bm25 integration' } },
        { schema: 'data/abstraction/note', data: { title: 'Ideas', content: 'try hybrid search combining bm25 with embeddings' } },
    ];

    const ids = [];
    for (const n of notes) {
        const id = await db.insertDocument(n, context, features);
        ids.push(id);
    }
    console.log('Inserted note IDs:', ids);


    // Simple FTS via query()
    const q1 = await db.query('bm25 integration', '/', ['data/abstraction/note'], [], { limit: 10 });
    console.log('Query bm25 integration -> count:', q1.count, 'ids:', q1.map(d => d.id));

    const q2 = await db.query('shopping bananas', '/', ['data/abstraction/note'], [], { limit: 10 });
    console.log('Query shopping bananas -> count:', q2.count, 'ids:', q2.map(d => d.id));

    await db.shutdown();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});


