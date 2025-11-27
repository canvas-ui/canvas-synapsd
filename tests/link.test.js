import Link from '../src/schemas/abstractions/Link.js';

describe('Link abstraction', () => {

    test('normalizes whitespace and extracts scheme', () => {
        const link = new Link({
            data: {
                uri: '   https://example.com/docs?id=1   ',
                label: 'Docs',
            },
        });

        expect(link.uri).toBe('https://example.com/docs?id=1');
        expect(link.scheme).toBe('https');

        link.uri = 'file:///var/logs/build.log';
        expect(link.uri).toBe('file:///var/logs/build.log');
        expect(link.scheme).toBe('file');
    });

    test('accepts custom schemes and manages tags', () => {
        const link = new Link({
            data: {
                uri: 'devops+ssh://bastion/vm-42',
                label: 'Bastion shell',
                tags: ['ssh'],
            },
        });

        expect(link.scheme).toBe('devops+ssh');

        link.addTag('critical').addTag('ssh');
        expect(link.data.tags).toEqual(['ssh', 'critical']);

        link.removeTag('ssh');
        expect(link.data.tags).toEqual(['critical']);
    });

    test('touch updates timestamp without mutating uri', () => {
        const now = new Date().toISOString();
        const link = new Link({
            data: {
                uri: 'mailto:alerts@example.com',
                label: 'On-call DL',
            },
        });

        link.touch(now);
        expect(link.data.lastAccessedAt).toBe(now);
        expect(link.uri).toBe('mailto:alerts@example.com');
    });
});
