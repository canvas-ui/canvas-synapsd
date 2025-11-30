import { initializeTestDB, cleanupTestDB } from './helpers.js';
import { startOfYesterday, endOfYesterday, subDays, addDays } from 'date-fns';

describe('Timestamp Index (BSI)', () => {
    let db;

    beforeAll(async () => {
        db = await initializeTestDB();
    });

    afterAll(async () => {
        await cleanupTestDB(db);
    });

    test('should index and retrieve documents by timestamp range', async () => {
        const now = new Date();
        const yesterday = subDays(now, 1);
        const lastWeek = subDays(now, 7);

        // Create documents with specific timestamps
        const doc1 = {
            schema: 'data/abstraction/note',
            data: { title: 'Today Note', content: 'Content 1' },
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
        };

        const doc2 = {
            schema: 'data/abstraction/note',
            data: { title: 'Yesterday Note', content: 'Content 2' },
            createdAt: yesterday.toISOString(),
            updatedAt: yesterday.toISOString(),
        };

        const doc3 = {
            schema: 'data/abstraction/note',
            data: { title: 'Last Week Note', content: 'Content 3' },
            createdAt: lastWeek.toISOString(),
            updatedAt: lastWeek.toISOString(),
        };

        const id1 = await db.insertDocument(doc1);
        const id2 = await db.insertDocument(doc2);
        const id3 = await db.insertDocument(doc3);

        // Test: Find today
        // We need to wait a tiny bit or ensure index flush? BSI is immediate in memory.

        // Use internal method first to verify index state
        const todayIds = await db.timestampIndex.findByTimeframe('today', 'created');
        expect(todayIds).toContain(id1);
        expect(todayIds).not.toContain(id2);
        expect(todayIds).not.toContain(id3);

        // Test: Find yesterday
        const yesterdayIds = await db.timestampIndex.findByTimeframe('yesterday', 'created');
        expect(yesterdayIds).not.toContain(id1);
        expect(yesterdayIds).toContain(id2);
        expect(yesterdayIds).not.toContain(id3);

        // Test: Range query (Last 2 days)
        const twoDaysAgo = subDays(now, 2);
        const rangeIds = await db.timestampIndex.findByRangeAndAction('created', twoDaysAgo, now);
        expect(rangeIds).toContain(id1);
        expect(rangeIds).toContain(id2);
        expect(rangeIds).not.toContain(id3);
    });

    test('should handle findDocuments with datetime filters', async () => {
        // This relies on db.findDocuments parsing "datetime:..." strings

        // Insert new docs to be sure
        const docA = { schema: 'data/abstraction/note', data: { text: 'A', content: 'Content A' }, createdAt: new Date().toISOString() };
        const idA = await db.insertDocument(docA);

        // Filter: datetime:created:today
        const result = await db.findDocuments('/', [], ['datetime:created:today']);
        const ids = result.map(d => d.id);
        expect(ids).toContain(idA);
    });

    test('should handle removal correctly', async () => {
        const doc = {
            schema: 'data/abstraction/note',
            data: { title: 'To Delete', content: 'Delete me' },
            createdAt: new Date().toISOString()
        };
        const id = await db.insertDocument(doc);

        // Verify exists
        let ids = await db.timestampIndex.findByTimeframe('today', 'created');
        expect(ids).toContain(id);

        // Delete
        await db.deleteDocument(id);

        // Verify removed from 'created' (deleteDocument clears all BSI values for the ID)
        ids = await db.timestampIndex.findByTimeframe('today', 'created');
        expect(ids).not.toContain(id);

        // Verify added to 'deleted' index
        const deletedIds = await db.timestampIndex.findByTimeframe('today', 'deleted');
        expect(deletedIds).toContain(id);
    });
});

