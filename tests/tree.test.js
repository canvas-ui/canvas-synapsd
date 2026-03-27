import { initializeTestDB, cleanupTestDB } from './helpers.js';

describe('SynapsD tree memberships', () => {
    let db;

    beforeAll(async () => {
        db = await initializeTestDB();
        await db.createTree('projects', 'context');
        await db.createTree('incoming', 'directory');
    });

    afterAll(async () => {
        await cleanupTestDB(db);
    });

    describe('Context tree semantics', () => {
        it('treats "/" as all real memberships in a context tree', async () => {
            const projectId = await db.put({
                schema: 'data/abstraction/note',
                data: { title: 'Project Note', content: 'ships in projects only' },
            }, { tree: 'projects', path: '/work/project-a' });

            const stagedId = await db.put({
                schema: 'data/abstraction/note',
                data: { title: 'Staged Note', content: 'sits only in incoming' },
            }, { tree: 'incoming', path: '/mail/inbox' });

            expect(await db.has(projectId, { tree: 'projects', path: '/' })).toBe(true);
            expect(await db.has(stagedId, { tree: 'projects', path: '/' })).toBe(false);

            const rootMatches = await db.find({ tree: 'projects', path: '/' });
            const ids = rootMatches.map((doc) => doc.id);
            expect(ids).toContain(projectId);
            expect(ids).not.toContain(stagedId);
        });

        it('refuses unlinking the synthetic context root', async () => {
            const id = await db.put({
                schema: 'data/abstraction/note',
                data: { title: 'Protected Root', content: 'context root is a selector, not a real layer' },
            }, { tree: 'projects', path: '/ops/release' });

            await expect(
                db.unlink(id, { tree: 'projects', path: '/' })
            ).rejects.toThrow('Cannot unlink from root context "/"');
        });
    });

    describe('Directory tree semantics', () => {
        it('keeps directory "/" literal while still exposing tree memberships', async () => {
            const rootId = await db.put({
                schema: 'data/abstraction/note',
                data: { title: 'Root Folder Doc', content: 'lives directly in /' },
            }, { tree: 'incoming', path: '/' });

            const nestedId = await db.put({
                schema: 'data/abstraction/note',
                data: { title: 'Nested Folder Doc', content: 'lives under /email/inbox' },
            }, { tree: 'incoming', path: '/email/inbox' });

            const rootFolderDocs = await db.find({ tree: 'incoming', path: '/' });
            const rootFolderIds = rootFolderDocs.map((doc) => doc.id);
            expect(rootFolderIds).toContain(rootId);
            expect(rootFolderIds).not.toContain(nestedId);

            expect(await db.hasDocumentTreeMembership(rootId, 'incoming')).toBe(true);
            expect(await db.hasDocumentTreeMembership(nestedId, 'incoming')).toBe(true);
        });

        it('removes tree membership after the last directory unlink', async () => {
            const id = await db.put({
                schema: 'data/abstraction/note',
                data: { title: 'Multi Path Stage', content: 'linked into two staging folders' },
            }, { tree: 'incoming', path: ['/mail/inbox', '/mail/review'] });

            expect(await db.listDocumentTreePaths(id, 'incoming')).toEqual(
                expect.arrayContaining(['/mail/inbox', '/mail/review'])
            );

            await db.unlink(id, { tree: 'incoming', path: '/mail/inbox' });
            expect(await db.hasDocumentTreeMembership(id, 'incoming')).toBe(true);

            await db.unlink(id, { tree: 'incoming', path: '/mail/review' });
            expect(await db.hasDocumentTreeMembership(id, 'incoming')).toBe(false);
            expect(await db.listDocumentTreePaths(id, 'incoming')).toEqual([]);
        });
    });

    describe('Incoming promotion flow', () => {
        it('promotes a staged document into a user tree without keeping stale incoming paths', async () => {
            const id = await db.put({
                schema: 'data/abstraction/note',
                data: { title: 'Promoted Note', content: 'keep this one' },
            }, { tree: 'incoming', path: '/email/account/inbox' });

            await db.link(id, { tree: 'projects', path: '/kept' });
            await db.unlink(id, { tree: 'incoming', path: '/email/account/inbox' });

            expect(await db.has(id, { tree: 'projects', path: '/kept' })).toBe(true);
            expect(await db.hasDocumentTreeMembership(id, 'incoming')).toBe(false);
            expect(await db.has(id, { tree: 'incoming', path: '/email/account/inbox' })).toBe(false);
        });
    });
});
