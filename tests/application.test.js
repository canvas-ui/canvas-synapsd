
import Application from '../src/schemas/abstractions/Application.js';

describe('Application Abstraction', () => {
    it('should create an Application instance for appimage with required source.url', () => {
        const doc = Application.fromData({
            data: {
                appId: 'com.example.MyApp',
                name: 'My App',
                type: 'appimage',
                source: { url: 'https://example.com/MyApp.AppImage', sha256: 'deadbeef' },
                installs: {
                    dev1: { status: 'available', path: '~/Apps/MyApp.AppImage', version: '1.2.3' },
                },
            },
        });

        expect(doc.appId).toBe('com.example.MyApp');
        expect(doc.type).toBe('appimage');
        expect(doc.installs.dev1.path).toBe('$HOME/Apps/MyApp.AppImage');
        expect(doc.allInstallPaths).toContain('$HOME/Apps/MyApp.AppImage');
    });

    it('should reject appimage without source.url', () => {
        expect(() => Application.fromData({
            data: {
                appId: 'com.example.Bad',
                type: 'appimage',
                source: {},
            },
        })).toThrow();
    });

    it('should accept system app without source', () => {
        const doc = Application.fromData({
            data: {
                appId: 'system:terminal',
                type: 'system',
                installs: {
                    dev1: { status: 'available', path: '/usr/bin/gnome-terminal' },
                },
            },
        });
        expect(doc.type).toBe('system');
        expect(doc.isAvailableOn('dev1')).toBe(true);
    });

    it('should manage install state via helpers', () => {
        const doc = Application.fromData({
            data: {
                appId: 'com.example.Portable',
                type: 'portable',
                source: { repoPath: 'apps/portable/com.example.Portable' },
            },
        });

        doc.markAvailable('dev-x', { path: '{{HOME}}/bin/portable-app', version: '0.1.0' });
        expect(doc.getInstall('dev-x').status).toBe('available');
        expect(doc.getInstall('dev-x').path).toBe('$HOME/bin/portable-app');

        doc.markMissing('dev-x');
        expect(doc.getInstall('dev-x').status).toBe('missing');

        doc.removeInstall('dev-x');
        expect(doc.getInstall('dev-x')).toBeUndefined();
    });
});

