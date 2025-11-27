import Contact from '../src/schemas/abstractions/Contact.js';

describe('Contact abstraction', () => {

    test('tracks primary email and ensures email channel entry', () => {
        const contact = new Contact({
            data: { displayName: 'Alice Example' },
        });

        contact.primaryEmail = 'Alice@Example.com';

        expect(contact.primaryEmail).toBe('alice@example.com');
        expect(contact.data.channels).toHaveLength(1);
        expect(contact.data.channels[0]).toMatchObject({
            kind: 'email',
            value: 'alice@example.com',
            primary: true,
        });
    });

    test('deduplicates identities and keeps a single primary', () => {
        const contact = new Contact({
            data: {
                displayName: 'Bob Integrations',
                identities: [{ type: 'integration', identifier: 'slack:U1' }],
            },
        });

        contact.addIdentity({ type: 'canvas-user', identifier: 'user-1', primary: true });
        contact.addIdentity({ type: 'canvas-user', identifier: 'user-1', metadata: { workspace: 'core' } });

        expect(contact.data.identities).toHaveLength(2);
        const canvasIdentity = contact.data.identities.find((identity) => identity.type === 'canvas-user');
        expect(canvasIdentity.primary).toBe(true);
        expect(canvasIdentity.metadata).toEqual({ workspace: 'core' });
    });

    test('links resources to context paths and merges metadata', () => {
        const contact = new Contact({
            data: { displayName: 'Link Tester' },
        });

        const contextTarget = '/work/foo/devops/jira-1234';
        contact.linkResource({
            type: 'context',
            target: contextTarget,
            contextPath: contextTarget,
        });

        contact.linkResource({
            type: 'context',
            target: contextTarget,
            metadata: { thread: 'alerts' },
        });

        expect(contact.data.links).toHaveLength(1);
        expect(contact.data.links[0]).toMatchObject({
            type: 'context',
            target: contextTarget,
            metadata: { thread: 'alerts' },
        });
    });
});
