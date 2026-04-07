'use strict';

/**
 * Shared path utilities for device-local path schemas (Dotfile, Application, …)
 *
 * Paths stored in these schemas may contain shell-style placeholders that must
 * be resolved at runtime against the actual device environment:
 *   $HOME  /  ~  /  {{HOME}}  →  normalised to $HOME at rest
 *
 * Matching pattern covers the common subset used on Unix-like systems.
 * Windows paths are not in scope.
 */

// Allows: /abs/path, ~/path, $HOME/path, $VAR/path, {{VAR}}/path
export const pathPattern = /^(\{\{\s*[A-Za-z0-9_]+\s*\}\}|\$[A-Za-z0-9_]+|~)?[/A-Za-z0-9_. -]+$/;

/**
 * Normalise common home-directory placeholders to the canonical $HOME form.
 * Handles: ~  {{home}}  {{HOME}}  (any capitalisation)
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeHomePlaceholder(input) {
    if (typeof input !== 'string') { return input; }
    return input
        .replace(/^(\{\{\s*home\s*\}\})(?=\/|$)/i, '$HOME')
        .replace(/^~(?=\/|$)/, '$HOME');
}

/**
 * Build a device-qualified file:// URL for a local path.
 * Placeholder variables (e.g. $HOME) are kept as-is; callers are expected to
 * resolve them when they have access to the device registry.
 *
 * @param {string} deviceId
 * @param {string} localPath  — may start with $HOME, /abs, etc.
 * @returns {string}  e.g. "file://abc123/$HOME/.bashrc"
 */
export function deviceFileUrl(deviceId, localPath) {
    if (!deviceId || !localPath) { return null; }
    // Ensure exactly one slash between authority and path
    const sep = localPath.startsWith('/') ? '' : '/';
    return `file://${deviceId}${sep}${localPath}`;
}
