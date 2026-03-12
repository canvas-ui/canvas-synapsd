import { initializeTestDB, cleanupTestDB } from './helpers.js';

describe('Search', () => {
    let db;

    beforeAll(async () => {
        db = await initializeTestDB();
    });

    afterAll(async () => {
        await cleanupTestDB(db);
    });

    it('should query all documents without requiring bitmap filters', async () => {
        const matchingId = await db.insertDocument({
            schema: 'data/abstraction/note',
            data: {
                title: 'Alpha Incident',
                content: 'GPU driver alpha failure on workstation'
            }
        });

        await db.insertDocument({
            schema: 'data/abstraction/note',
            data: {
                title: 'Beta Incident',
                content: 'Routine browser tab sync noise'
            }
        });

        const result = await db.query('alpha');
        const ids = result.map(doc => doc.id);

        expect(result.error).toBeNull();
        expect(ids).toContain(matchingId);
    });
});
