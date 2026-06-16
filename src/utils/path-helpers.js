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

/**
 * Parse a `locations[].url` into its parts. Covers the canvas URL grammar:
 *   stored://<backend>/<key>            backend may contain ':' (e.g. workspace:data)
 *   file://{WORKSPACE_ROOT}/<path>      authority is the literal {WORKSPACE_ROOT} token
 *   file://<deviceId>/<path>            authority is a device id or user@host alias
 *   imap://<account>/<folder>;UID=<n>   RFC 5092; the ;UID= param stays in `key`
 *   s3://<bucket>/<key>, http(s)://…    authority is bucket/host
 *
 * Deliberately hand-rolled rather than WHATWG `new URL`, because the literal
 * `{WORKSPACE_ROOT}` token and bare device ids are not valid URL authorities.
 *
 * @param {string} url
 * @returns {{scheme:string, backend:string, key:string, query:(string|null)}|null}
 *   `backend` is the authority segment (the Stored backend name for stored://,
 *   otherwise the host/device/bucket). `key` is everything after it.
 */
export function parseLocationUrl(url) {
    if (typeof url !== 'string') { return null; }
    const schemeMatch = url.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    if (!schemeMatch) { return null; }

    const scheme = schemeMatch[1].toLowerCase();
    let rest = url.slice(schemeMatch[0].length);

    // Peel off a query string; keep it separate from the key.
    let query = null;
    const qIdx = rest.indexOf('?');
    if (qIdx >= 0) {
        query = rest.slice(qIdx + 1);
        rest = rest.slice(0, qIdx);
    }

    // authority = up to the first '/', everything after is the key/path.
    const slash = rest.indexOf('/');
    const backend = slash < 0 ? rest : rest.slice(0, slash);
    const key = slash < 0 ? '' : rest.slice(slash + 1);

    return { scheme, backend, key, query };
}
