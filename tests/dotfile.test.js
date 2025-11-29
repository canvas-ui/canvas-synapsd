
import Dotfile from '../src/schemas/abstractions/Dotfile.js';
import { describe, it, expect } from '@jest/globals';

describe('Dotfile Abstraction', () => {
    const validData = {
        repoPath: 'shell/aliases',
        type: 'file',
        links: {
            'dev-1': '~/.bash_aliases',
            'dev-2': '~/.aliases'
        }
    };

    it('should create a Dotfile instance with valid data', () => {
        const doc = Dotfile.fromData({ data: validData });
        expect(doc.repoPath).toBe('shell/aliases');
        expect(doc.type).toBe('file');
        expect(doc.links['dev-1']).toBe('$HOME/.bash_aliases');
        expect(doc.links['dev-2']).toBe('$HOME/.aliases');
    });

    it('should normalize local paths in links', () => {
        const doc = Dotfile.fromData({
            data: {
                repoPath: 'config/vimrc',
                type: 'file',
                links: {
                    'mac': '{{HOME}}/.vimrc',
                    'linux': '~/.vimrc'
                }
            }
        });
        expect(doc.links['mac']).toBe('$HOME/.vimrc');
        expect(doc.links['linux']).toBe('$HOME/.vimrc');
    });

    it('should compute allLocalPaths correctly for search', () => {
        const doc = Dotfile.fromData({ data: validData });
        // $HOME substitution happens in constructor/schema transform
        expect(doc.allLocalPaths).toContain('$HOME/.bash_aliases');
        expect(doc.allLocalPaths).toContain('$HOME/.aliases');
    });

    it('should manage links via methods', () => {
        const doc = Dotfile.fromData({
            data: { repoPath: 'test', type: 'file' }
        });

        doc.addLink('dev-1', '~/path');
        expect(doc.links['dev-1']).toBe('$HOME/path');

        doc.removeLink('dev-1');
        expect(doc.links['dev-1']).toBeUndefined();
    });

    it('should detect conflicts based on repoPath', () => {
        const doc1 = Dotfile.fromData({ data: { repoPath: 'same', type: 'file' } });
        const doc2 = Dotfile.fromData({ data: { repoPath: 'same', type: 'file' } });
        expect(doc1.conflictsWith(doc2)).toBe(true);
    });

    it('should detect conflicts based on device local path', () => {
        const doc1 = Dotfile.fromData({
            data: {
                repoPath: 'a', type: 'file',
                links: { 'd1': '~/common' }
            }
        });
        const doc2 = Dotfile.fromData({
            data: {
                repoPath: 'b', type: 'file',
                links: { 'd1': '~/common' }
            }
        });
        expect(doc1.conflictsWith(doc2)).toBe(true);
    });

    it('should NOT detect conflicts for same path on different devices', () => {
        const doc1 = Dotfile.fromData({
            data: {
                repoPath: 'a', type: 'file',
                links: { 'd1': '~/common' }
            }
        });
        const doc2 = Dotfile.fromData({
            data: {
                repoPath: 'b', type: 'file',
                links: { 'd2': '~/common' }
            }
        });
        expect(doc1.conflictsWith(doc2)).toBe(false);
    });

    it('should generate correct FTS data', () => {
        const doc = Dotfile.fromData({ data: validData });
        const ftsData = doc.generateFtsData();
        // ftsSearchFields: ['allLocalPaths', 'data.repoPath']
        // allLocalPaths is "$HOME/.bash_aliases $HOME/.aliases"
        // repoPath is "shell/aliases"
        expect(ftsData).toBeDefined();
        expect(ftsData.length).toBeGreaterThanOrEqual(2);
        expect(ftsData.some(s => s.includes('$HOME/.bash_aliases'))).toBe(true);
        expect(ftsData.some(s => s.includes('shell/aliases'))).toBe(true);
    });

    it('should generate correct checksum based only on repoPath', () => {
        const doc1 = Dotfile.fromData({
            data: {
                repoPath: 'config', type: 'file',
                links: { 'd1': '~/path' }
            }
        });
        // Change links, checksum should be same (as we only checksum repoPath now per design logic?)
        // Wait, if links change, the document data changes.
        // But `checksumFields` is `['data.repoPath']`.
        // So the PRIMARY checksum (identity) should rely on repoPath.
        // If I change links, the `checksumArray` generated might be the same if it only uses those fields.

        const cs1 = doc1.generateChecksumData();

        const doc2 = Dotfile.fromData({
            data: {
                repoPath: 'config', type: 'file',
                links: { 'd2': '~/other' }
            }
        });
        const cs2 = doc2.generateChecksumData();

        expect(cs1).toBe(cs2);
    });
});

