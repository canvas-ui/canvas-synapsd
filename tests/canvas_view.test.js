import { initializeTestDB, cleanupTestDB } from './helpers.js';

describe('Canvas views (as layers)', () => {
    let db;

    beforeAll(async () => {
        db = await initializeTestDB();
    });

    afterAll(async () => {
        await cleanupTestDB(db);
    });

    it('should create a canvas layer with view config and query through it', async () => {
        const canvasPath = '/work/customer/devops/jira-1234';

        await db.createCanvas(canvasPath, {
            view: {
                features: ['data/abstraction/note'],
            },
            acl: { owner: 'canvas-app', access: 'rw' },
        });

        const noteId = await db.insertDocument(
            { schema: 'data/abstraction/note', data: { title: 'N', content: 'C' } },
            canvasPath
        );
        const tabId = await db.insertDocument(
            { schema: 'data/abstraction/tab', data: { title: 'T', url: 'https://example.com' } },
            canvasPath
        );

        const notesOnly = await db.queryCanvas(canvasPath);
        const ids = notesOnly.map(d => d.id);
        expect(ids).toContain(noteId);
        expect(ids).not.toContain(tabId);

        // Expand feature set to include tabs too
        await db.updateCanvas(canvasPath, { view: { features: ['data/abstraction/note', 'data/abstraction/tab'] } });
        const notesAndTabs = await db.queryCanvas(canvasPath);
        const ids2 = notesAndTabs.map(d => d.id);
        expect(ids2).toContain(noteId);
        expect(ids2).toContain(tabId);

        const canvasLayer = db.getCanvas(canvasPath);
        expect(canvasLayer.type).toBe('canvas');
        expect(canvasLayer.metadata?.view?.features).toContain('data/abstraction/note');
        expect(canvasLayer.acl).toEqual({ owner: 'canvas-app', access: 'rw' });
    });

    it('should dedupe canvases by leaf name (same layer reused across mounts)', async () => {
        const pathA = '/work/customer/devops/jira-1234';
        const pathB = '/other/jira-1234';

        await db.createCanvas(pathB, {
            view: { contextUrl: 'app://canvas/jira-1234' },
        });

        const a = db.getCanvas(pathA);
        const b = db.getCanvas(pathB);

        // Same leaf name => same underlying layer id (dedup-by-name semantics)
        expect(a.id).toBe(b.id);
        // Metadata is shared too
        expect(b.metadata?.view?.contextUrl).toBe('app://canvas/jira-1234');
    });
});

