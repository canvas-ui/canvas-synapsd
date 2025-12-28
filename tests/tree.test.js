import fs from 'fs';
import SynapsD from '../src/index.js';

const TEST_DB_PATH = '/tmp/synapsd-tree-test';

describe('SynapsD Tree Operations', () => {
    let db;

    beforeAll(async () => {
        if (fs.existsSync(TEST_DB_PATH)) {
            fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
        }
        fs.mkdirSync(TEST_DB_PATH, { recursive: true });

        db = new SynapsD({ path: TEST_DB_PATH });
        await db.start();
    });

    afterAll(async () => {
        if (db && db.isRunning()) {
            await db.shutdown();
        }
        if (fs.existsSync(TEST_DB_PATH)) {
            fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
        }
    });


    // ============================================================================
    // Basic Document Insertion with Paths
    // ============================================================================

    describe('Basic Document Insertion', () => {
        it('should insert document at root path', async () => {
            const doc = {
                schema: 'data/abstraction/note',
                data: { title: 'Root Note', content: 'Content at root' }
            };

            const docId = await db.insertDocument(doc, '/');

            expect(docId).toBeDefined();
            expect(typeof docId).toBe('number');
            expect(docId).toBeGreaterThan(100000);

            const retrieved = await db.getDocumentById(docId);
            expect(retrieved.data.title).toBe('Root Note');
        });

        it('should insert document at nested path', async () => {
            const doc = {
                schema: 'data/abstraction/note',
                data: { title: 'Nested Note', content: 'Content in project' }
            };

            const docId = await db.insertDocument(doc, '/projects/alpha');

            expect(docId).toBeDefined();
            const retrieved = await db.getDocumentById(docId);
            expect(retrieved.data.title).toBe('Nested Note');
        });

        it('should insert document at deeply nested path', async () => {
            const doc = {
                schema: 'data/abstraction/tab',
                data: {
                    title: 'Deep Tab',
                    url: 'https://example.com/deep'
                }
            };

            const docId = await db.insertDocument(doc, '/projects/beta/frontend/components');

            expect(docId).toBeDefined();
            const retrieved = await db.getDocumentById(docId);
            expect(retrieved.data.url).toBe('https://example.com/deep');
        });

        it('should normalize path with extra slashes', async () => {
            const doc = {
                schema: 'data/abstraction/note',
                data: { title: 'Normalized Path', content: 'Test content' }
            };

            const docId = await db.insertDocument(doc, '//projects//test//');

            expect(docId).toBeDefined();
            const hasDoc = await db.hasDocument(docId, '/projects/test');
            expect(hasDoc).toBe(true);
        });
    });

    // ============================================================================
    // Context Hierarchy and Layer Operations
    // ============================================================================

    describe('Context Hierarchy', () => {
        it('should create all parent layers when inserting at nested path', async () => {
            const doc = {
                schema: 'data/abstraction/note',
                data: { title: 'Layer Test', content: 'Layer content' }
            };

            const docId = await db.insertDocument(doc, '/work/project-x/docs');

            // Document should exist in all parent contexts
            expect(await db.hasDocument(docId, '/')).toBe(true);
            expect(await db.hasDocument(docId, '/work')).toBe(true);
            expect(await db.hasDocument(docId, '/work/project-x')).toBe(true);
            expect(await db.hasDocument(docId, '/work/project-x/docs')).toBe(true);
        });

        it('should maintain separate context hierarchies', async () => {
            const doc1 = {
                schema: 'data/abstraction/note',
                data: { title: 'Doc 1', content: 'Content 1' }
            };
            const doc2 = {
                schema: 'data/abstraction/note',
                data: { title: 'Doc 2', content: 'Content 2' }
            };

            const id1 = await db.insertDocument(doc1, '/workspace/project-a');
            const id2 = await db.insertDocument(doc2, '/workspace/project-b');

            // Both should be in /workspace
            expect(await db.hasDocument(id1, '/workspace')).toBe(true);
            expect(await db.hasDocument(id2, '/workspace')).toBe(true);

            // But not in each other's specific paths
            expect(await db.hasDocument(id1, '/workspace/project-b')).toBe(false);
            expect(await db.hasDocument(id2, '/workspace/project-a')).toBe(false);
        });

        it('should find documents by context path', async () => {
            const doc1 = {
                schema: 'data/abstraction/tab',
                data: { title: 'Tab 1', url: 'https://example.com/1' }
            };
            const doc2 = {
                schema: 'data/abstraction/tab',
                data: { title: 'Tab 2', url: 'https://example.com/2' }
            };

            await db.insertDocument(doc1, '/browser/session-1');
            await db.insertDocument(doc2, '/browser/session-1');

            const result = await db.findDocuments('/browser/session-1');

            expect(result).not.toBeNull();
            expect(result.count).toBeGreaterThanOrEqual(2);
        });
    });

    // ============================================================================
    // Bitmap Operations (Features)
    // ============================================================================

    describe('Feature Bitmap Operations', () => {
        it('should automatically index document by schema', async () => {
            const doc = {
                schema: 'data/abstraction/note',
                data: { title: 'Schema Test', content: 'Schema content' }
            };

            const docId = await db.insertDocument(doc);

            // Document should be findable by its schema
            const result = await db.findDocuments('/', ['data/abstraction/note']);

            expect(result).not.toBeNull();
            expect(result.count).toBeGreaterThan(0);

            const ids = result.map(d => d.id);
            expect(ids).toContain(docId);
        });

        it('should index document with custom features', async () => {
            const doc = {
                schema: 'data/abstraction/tab',
                data: {
                    title: 'Feature Test',
                    url: 'https://example.com'
                }
            };

            const docId = await db.insertDocument(
                doc,
                '/features',
                ['custom/important', 'custom/archived']
            );

            // Should find by custom feature
            const result = await db.findDocuments('/', ['custom/important']);

            expect(result).not.toBeNull();
            const ids = result.map(d => d.id);
            expect(ids).toContain(docId);
        });

        it('should support multiple feature filters with AND logic', async () => {
            const doc = {
                schema: 'data/abstraction/note',
                data: { title: 'Multi Feature', content: 'Multi content' }
            };

            const docId = await db.insertDocument(
                doc,
                '/',
                ['tag/javascript', 'tag/tutorial', 'tag/beginner']
            );

            // Should find with multiple filters
            const result = await db.findDocuments(
                '/',
                ['tag/javascript', 'tag/tutorial']
            );

            expect(result).not.toBeNull();
            const ids = result.map(d => d.id);
            expect(ids).toContain(docId);
        });
    });

    // ============================================================================
    // Combined Context and Feature Queries
    // ============================================================================

    describe('Combined Context and Feature Queries', () => {
        it('should filter by both context and features', async () => {
            const doc1 = {
                schema: 'data/abstraction/note',
                data: { title: 'JavaScript Note', content: 'JS content' }
            };
            const doc2 = {
                schema: 'data/abstraction/note',
                data: { title: 'Python Note', content: 'Python content' }
            };

            const id1 = await db.insertDocument(
                doc1,
                '/tutorials/web',
                ['tag/javascript']
            );
            const id2 = await db.insertDocument(
                doc2,
                '/tutorials/backend',
                ['tag/python']
            );

            // Find only JavaScript notes in web tutorials
            const result = await db.findDocuments(
                '/tutorials/web',
                ['tag/javascript']
            );

            expect(result).not.toBeNull();
            const ids = result.map(d => d.id);
            expect(ids).toContain(id1);
            expect(ids).not.toContain(id2);
        });

        it('should handle complex nested paths with multiple features', async () => {
            const doc = {
                schema: 'data/abstraction/tab',
                data: {
                    title: 'Complex Doc',
                    url: 'https://complex.example.com'
                }
            };

            const docId = await db.insertDocument(
                doc,
                '/company/department/team/project',
                ['client/os/linux', 'client/browser/chrome', 'tag/important']
            );

            // Should be findable with all filters
            const result = await db.findDocuments(
                '/company/department/team/project',
                ['client/os/linux', 'tag/important']
            );

            expect(result).not.toBeNull();
            const ids = result.map(d => d.id);
            expect(ids).toContain(docId);
        });
    });

    // ============================================================================
    // Tree Structure and Integrity
    // ============================================================================

    describe('Tree Structure', () => {
        it('should build valid JSON tree structure', async () => {
            await db.insertDocument(
                { schema: 'data/abstraction/note', data: { title: 'N1', content: 'C1' } },
                '/tree-test/branch-a'
            );
            await db.insertDocument(
                { schema: 'data/abstraction/note', data: { title: 'N2', content: 'C2' } },
                '/tree-test/branch-b'
            );

            const tree = db.tree.buildJsonTree();

            expect(tree).toBeDefined();
            expect(tree.name).toBe('/');
            expect(tree.children).toBeDefined();
        });

        it('should handle document removal from specific context', async () => {
            const doc = {
                schema: 'data/abstraction/note',
                data: { title: 'Removal Test', content: 'Removal content' }
            };

            const docId = await db.insertDocument(doc, '/removal/test/deep');

            // Verify it exists in all contexts
            expect(await db.hasDocument(docId, '/removal/test/deep')).toBe(true);
            expect(await db.hasDocument(docId, '/removal/test')).toBe(true);
            expect(await db.hasDocument(docId, '/removal')).toBe(true);

            // Remove from specific context only (non-recursive)
            await db.removeDocument(docId, '/removal/test/deep');

            // Should not exist in specific context
            expect(await db.hasDocument(docId, '/removal/test/deep')).toBe(false);

            // Should still exist in parent contexts
            expect(await db.hasDocument(docId, '/removal/test')).toBe(true);
            expect(await db.hasDocument(docId, '/removal')).toBe(true);
            expect(await db.hasDocument(docId, '/')).toBe(true);
        });

        it('should prevent removal from root context', async () => {
            const doc = {
                schema: 'data/abstraction/note',
                data: { title: 'Root Protection', content: 'Protected content' }
            };

            const docId = await db.insertDocument(doc, '/protected/path');

            await expect(
                db.removeDocument(docId, '/')
            ).rejects.toThrow();

            // Document should still exist
            expect(await db.hasDocument(docId, '/')).toBe(true);
        });
    });

    // ============================================================================
    // Batch Operations with Tree
    // ============================================================================

    describe('Batch Operations', () => {
        it('should insert multiple documents at same path', async () => {
            const docs = [
                { schema: 'data/abstraction/note', data: { title: 'Batch 1', content: 'BC1' } },
                { schema: 'data/abstraction/note', data: { title: 'Batch 2', content: 'BC2' } },
                { schema: 'data/abstraction/note', data: { title: 'Batch 3', content: 'BC3' } }
            ];

            const result = await db.insertDocumentArray(docs, '/batch/test');

            expect(result).toHaveLength(3);
            expect(Array.isArray(result)).toBe(true);

            // All should be in the same context
            for (const docId of result) {
                expect(await db.hasDocument(docId, '/batch/test')).toBe(true);
            }
        });

        it('should insert documents at different paths within same batch', async () => {
            const docs = [
                { schema: 'data/abstraction/note', data: { title: 'Path A', content: 'CA' } },
                { schema: 'data/abstraction/note', data: { title: 'Path B', content: 'CB' } }
            ];

            // Note: insertDocumentArray puts all in same context
            // For different paths, need individual inserts
            const id1 = await db.insertDocument(docs[0], '/different/path-a');
            const id2 = await db.insertDocument(docs[1], '/different/path-b');

            expect(await db.hasDocument(id1, '/different/path-a')).toBe(true);
            expect(await db.hasDocument(id2, '/different/path-b')).toBe(true);
            expect(await db.hasDocument(id1, '/different/path-b')).toBe(false);
            expect(await db.hasDocument(id2, '/different/path-a')).toBe(false);
        });
    });

    // ============================================================================
    // Edge Cases
    // ============================================================================

    describe('Edge Cases', () => {
        it('should handle empty path (defaults to root)', async () => {
            const doc = {
                schema: 'data/abstraction/note',
                data: { title: 'Empty Path', content: 'Empty content' }
            };

            const docId = await db.insertDocument(doc, '');

            expect(await db.hasDocument(docId, '/')).toBe(true);
        });

        it('should handle null path (defaults to root)', async () => {
            const doc = {
                schema: 'data/abstraction/note',
                data: { title: 'Null Path', content: 'Null content' }
            };

            const docId = await db.insertDocument(doc, null);

            expect(await db.hasDocument(docId, '/')).toBe(true);
        });

        it('should handle path with special characters', async () => {
            const doc = {
                schema: 'data/abstraction/note',
                data: { title: 'Special Chars', content: 'Special content' }
            };

            // Special chars should be normalized
            const docId = await db.insertDocument(doc, '/test-path_123/item.name');

            expect(docId).toBeDefined();
            expect(await db.hasDocument(docId, '/test-path_123/item.name')).toBe(true);
        });

        it('should not find documents in non-existent paths', async () => {
            const result = await db.findDocuments('/non/existent/path');

            expect(result).not.toBeNull();
            expect(result.count).toBe(0);
            expect(result).toHaveLength(0);
        });
    });
});

