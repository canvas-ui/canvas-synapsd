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

    it('should exclude incoming documents from root listings when requested', async () => {
        const visibleId = await db.insertDocument({
            schema: 'data/abstraction/note',
            data: {
                title: 'Visible Result',
                content: 'This should stay in the normal root view'
            }
        }, '/projects/visible');

        const hiddenId = await db.insertDocument({
            schema: 'data/abstraction/note',
            data: {
                title: 'Incoming Result',
                content: 'This should stay quarantined'
            }
        }, '/.incoming/email/test-account/inbox');

        const rootResult = await db.findDocuments('/', [], [], {
            excludeContextSpec: '/.incoming',
        });
        const incomingResult = await db.findDocuments('/.incoming');

        expect(rootResult.map(doc => doc.id)).toContain(visibleId);
        expect(rootResult.map(doc => doc.id)).not.toContain(hiddenId);
        expect(incomingResult.map(doc => doc.id)).toContain(hiddenId);
    });

    it('should exclude incoming documents from full-text search when requested', async () => {
        await db.insertDocument({
            schema: 'data/abstraction/note',
            data: {
                title: 'Visible Search Hit',
                content: 'searchterm-visible'
            }
        }, '/projects/search');

        const hiddenId = await db.insertDocument({
            schema: 'data/abstraction/note',
            data: {
                title: 'Incoming Search Hit',
                content: 'searchterm-hidden'
            }
        }, '/.incoming/message/slack/random');

        const hiddenResults = await db.ftsQuery('searchterm-hidden', '/', [], [], {
            excludeContextSpec: '/.incoming',
        });
        const incomingResults = await db.ftsQuery('searchterm-hidden', '/.incoming');

        expect(hiddenResults.map(doc => doc.id)).not.toContain(hiddenId);
        expect(incomingResults.map(doc => doc.id)).toContain(hiddenId);
    });
});
