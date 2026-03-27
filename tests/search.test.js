import { initializeTestDB, cleanupTestDB } from './helpers.js';

describe('Search', () => {
    let db;

    beforeAll(async () => {
        db = await initializeTestDB();
        await db.createTree('projects', 'context');
        await db.createTree('incoming', 'directory');
    });

    afterAll(async () => {
        await cleanupTestDB(db);
    });

    describe('Basic search', () => {
        it('queries documents without requiring tree filters', async () => {
            const matchingId = await db.put({
                schema: 'data/abstraction/note',
                data: {
                    title: 'Alpha Incident',
                    content: 'GPU driver alpha failure on workstation',
                },
            });

            await db.put({
                schema: 'data/abstraction/note',
                data: {
                    title: 'Beta Incident',
                    content: 'Routine browser tab sync noise',
                },
            });

            const result = await db.search({ query: 'alpha' });
            const ids = result.map((doc) => doc.id);

            expect(result.error).toBeNull();
            expect(ids).toContain(matchingId);
        });
    });

    describe('Incoming exclusion', () => {
        it('excludes incoming-tree memberships from unrestricted listings when requested', async () => {
            const visibleId = await db.put({
                schema: 'data/abstraction/note',
                data: {
                    title: 'Visible Result',
                    content: 'This should stay in the normal root view',
                },
            }, { tree: 'projects', path: '/visible' });

            const hiddenId = await db.put({
                schema: 'data/abstraction/note',
                data: {
                    title: 'Incoming Result',
                    content: 'This should stay quarantined',
                },
            }, { tree: 'incoming', path: '/email/test-account/inbox' });

            const rootResult = await db.find({ excludeTree: 'incoming' });
            const incomingResult = await db.find({ tree: 'incoming', path: '/email/test-account/inbox' });

            expect(rootResult.map((doc) => doc.id)).toContain(visibleId);
            expect(rootResult.map((doc) => doc.id)).not.toContain(hiddenId);
            expect(incomingResult.map((doc) => doc.id)).toContain(hiddenId);
        });

        it('excludes incoming-tree memberships from full-text search when requested', async () => {
            await db.put({
                schema: 'data/abstraction/note',
                data: {
                    title: 'Visible Search Hit',
                    content: 'searchterm-visible',
                },
            }, { tree: 'projects', path: '/search' });

            const hiddenId = await db.put({
                schema: 'data/abstraction/note',
                data: {
                    title: 'Incoming Search Hit',
                    content: 'searchterm-hidden',
                },
            }, { tree: 'incoming', path: '/message/slack/random' });

            const hiddenResults = await db.search({
                query: 'searchterm-hidden',
                excludeTree: 'incoming',
            });
            const allResults = await db.search({ query: 'searchterm-hidden' });

            expect(hiddenResults.map((doc) => doc.id)).not.toContain(hiddenId);
            expect(allResults.map((doc) => doc.id)).toContain(hiddenId);
        });
    });
});
