import SynapsD from '../src/index.js';
const db = new SynapsD({
    path: '/tmp/synapsd-testdb',
});

const Tab = db.getSchema('data/abstraction/tab');
const Note = db.getSchema('data/abstraction/note');

/**
 * Sample documents
 */

const count = 5000;
let tabData;

async function insert() {
    await db.start();

    console.log(`Inserting ${count} tab documents...`);
    for (let i = 0; i < count; i++) {
        tabData = {
            schema: 'data/abstraction/tab',
            data: {
                title: `Tab ${i}`,
                url: `https://example.com/tab${i}`,
            },
        };

        await db.insertDocument(tabData);
    }

    console.log('DB stats after inserting tabs:', db.stats);
}

async function insertArray() {
    await db.start(); // Ensure DB is started, SynapsD.start() should be idempotent

    const docArray = [];
    console.log(`Preparing ${count} note documents for batch insert...`);
    for (let i = 0; i < count; i++) {
        tabData = {
            schema: 'data/abstraction/note',
            data: {
                title: `Note ${i}`,
                content: `Note content ${i}`,
            },
        };

        docArray.push(tabData);
    }

    await db.insertDocumentArray(docArray);
    console.log('DB stats after batch inserting notes:', db.stats);

}

insert().then(() => {
    console.log('Tab insertion complete. Starting first note batch insert...');
    return insertArray();
}).then(() => {
    console.log('First note batch insert complete. Listing notes...');
    return list();
}).then((notesCountAfterFirstBatch) => {
    console.log('Number of notes after first batch insert:', notesCountAfterFirstBatch);
    console.log('Starting second note batch insert...');
    return insertArray();
}).then(() => {
    console.log('Second note batch insert complete. Listing notes again...');
    return list();
}).then((notesCountAfterSecondBatch) => {
    console.log('Number of notes after second batch insert:', notesCountAfterSecondBatch);
    console.log('Test script finished successfully.');
}).catch((err) => {
    console.error('Error during test script execution:', err);
}).finally(async () => {
    if (db && db.status === 'running') {
        console.log('Shutting down SynapsD...');
        await db.stop();
        console.log('SynapsD shutdown complete.');
    }
});

async function list() {
    const documents = await db.listDocuments('/', ['data/abstraction/note']);
    console.log(documents.length);
    return documents.length;
}


