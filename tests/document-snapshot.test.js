import { describe, expect, test } from '@jest/globals';
import { snapshotDocument, hasSearchContentChanged } from '../src/documents/snapshot.js';
import { parseInitializeDocument } from '../src/utils/document.js';

const note = () => parseInitializeDocument({
    schema: 'data/schema/note',
    data: { title: 'Snapshot', content: 'original', relations: [{ p: 'references', to: 100002 }] },
    features: ['tag/original'],
    locations: [{ url: 'file://device/a', metadata: { source: 'original', backend: 'nas' } }],
    timelines: [{ timeline: 'history', start: '2020-01-01' }],
    comment: 'original comment',
    metadata: { summary: 'original summary', text: { content: 'original text' } },
});

describe('document before-state snapshots', () => {
    test('in-place document edits cannot change a snapshot or freeze the input', () => {
        const doc = note();
        const before = snapshotDocument(doc);
        const checksum = doc.getPrimaryChecksum();
        doc.locations[0].url = 'file://device/changed';
        doc.locations[0].metadata.backend = 'archive';
        doc.timelines[0].start = '2021-01-01';
        doc.data.relations[0].to = 100003;
        doc.features.push('tag/later');
        doc.update({ data: { title: 'Snapshot', content: 'changed' }, comment: '' });

        expect(before.checksums).toContain(checksum);
        expect(before.locations[0].url).toBe('file://device/a');
        expect(before.locations[0].metadata).toEqual({ backend: 'nas' });
        expect(before.timelines[0].start).toBe('2020-01-01');
        expect(before.relations).toEqual([{ p: 'references', to: 100002 }]);
        expect(before.featureKeys).not.toContain('tag/later');
        expect(before.comment).toBe('original comment');
        expect(() => before.locations.push({ url: 'file://other/a' })).toThrow();
        expect(() => { before.timelines[0].start = '2030-01-01'; }).toThrow();
    });

    test.each(['comment', 'summary', 'text', 'checksum'])('%s changes invalidate searchable content', field => {
        const doc = note();
        const before = snapshotDocument(doc);
        if (field === 'comment') { doc.comment = ''; }
        if (field === 'summary') { doc.metadata.summary = ''; }
        if (field === 'text') { doc.metadata.text.content = ''; }
        if (field === 'checksum') { doc.checksumArray = ['sha256/changed']; }
        expect(hasSearchContentChanged(before, doc)).toBe(true);
    });

    test('new documents need indexing; membership edits and checksum order do not', () => {
        const doc = note();
        doc.checksumArray = ['sha256/a', 'sha1/b'];
        const before = snapshotDocument(doc);
        doc.features = ['tag/other'];
        doc.locations = [];
        doc.checksumArray.reverse();
        expect(hasSearchContentChanged(before, doc)).toBe(false);
        expect(snapshotDocument(null)).toBeNull();
        expect(hasSearchContentChanged(null, doc)).toBe(true);
    });
});
