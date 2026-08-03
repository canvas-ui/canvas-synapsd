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
 * Build a pathless device presence URL.
 *
 * Some things are genuinely present on a device without living at a filesystem
 * path we know: a flatpak/snap/system package is "installed on device X" with no
 * portable path at all. Those still have to tick `device/id/<deviceId>`, or
 * "what is on this device" silently under-reports exactly the install types that
 * have no path.
 *
 * @param {string} deviceId
 * @returns {string|null} e.g. "device://abc123"
 */
export function deviceUrl(deviceId) {
    if (!deviceId) { return null; }
    return `device://${deviceId}`;
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

// The workspace's own dotfiles repo, in URI form. Deliberately id-free: the
// synapsd DB is already per-workspace, so a workspace id adds nothing to
// uniqueness while making identity break on workspace rename/move.
export const WORKSPACE_DOTFILES_REPO = 'workspace:dotfiles';

/**
 * Normalize a dotfile identity URI.
 *
 * A dotfile is a MAPPING between one entry in a dotfiles repo and N per-device
 * local paths, so its identity is "which entry in which repo" — a URI, not a
 * bare path. The repo lives in the scheme+authority, the entry in the fragment:
 *
 *   workspace:dotfiles#shell/bashrc                        the workspace's own repo
 *   git+ssh://git@github.com/me/dotfiles#shell/bashrc      an external repo
 *
 * Why this must normalize rather than accept input verbatim: identity is
 * `sha*(JSON.stringify(url))`, so `shell/bashrc`, `./shell/bashrc`,
 * `shell//bashrc` and `shell/bashrc/` would otherwise be FOUR documents for one
 * repo file. Normalizing in the schema (not in one client) is what actually
 * closes that, because every writer goes through it.
 *
 * A bare path is accepted and resolved to the workspace-local form — clients
 * doing the common thing should not have to spell out a URI.
 *
 * Case: scheme and host are lowercased (case-insensitive by RFC 3986); the
 * fragment is left alone, because repo paths ARE case-sensitive.
 *
 * @param {string} input URI or bare repo-relative path
 * @returns {string} normalized URI
 * @throws {Error} on traversal, empty entry, or an unparseable value
 */
export function normalizeDotfileUrl(input) {
    if (typeof input !== 'string') { throw new Error('Dotfile url must be a string'); }

    const value = input.normalize('NFC').trim();
    if (value === '') { throw new Error('Dotfile url must not be empty'); }

    const hashIndex = value.indexOf('#');
    let repo = hashIndex < 0 ? '' : value.slice(0, hashIndex);
    let entry = hashIndex < 0 ? value : value.slice(hashIndex + 1);

    // No scheme at all => a bare repo-relative path against the workspace repo.
    if (hashIndex < 0 && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
        repo = WORKSPACE_DOTFILES_REPO;
    } else if (repo === '') {
        throw new Error(`Dotfile url "${input}" has an empty repository part`);
    }

    // Lowercase scheme, and host for hierarchical (scheme://host/...) forms.
    // An opaque scheme's body (workspace:dotfiles) is a name, not a host, so it
    // is left as authored.
    repo = repo.replace(/^([a-z][a-z0-9+.-]*):/i, (_m, scheme) => `${scheme.toLowerCase()}:`);
    const hierarchical = repo.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/]+)(.*)$/i);
    if (hierarchical) {
        repo = `${hierarchical[1]}${hierarchical[2].toLowerCase()}${hierarchical[3]}`;
    }
    repo = repo.replace(/\/+$/, '');

    // Entry path: collapse duplicate slashes, drop './' segments and any
    // leading/trailing slash, then reject traversal outright — a dotfile entry
    // that escapes its repo is not a normalization question, it is invalid.
    entry = entry
        .split('/')
        .filter((segment) => segment !== '' && segment !== '.')
        .join('/');

    if (entry === '') { throw new Error(`Dotfile url "${input}" has an empty entry path`); }
    if (entry.split('/').includes('..')) {
        throw new Error(`Dotfile url "${input}" must not contain '..' path traversal`);
    }

    return `${repo}#${entry}`;
}

/**
 * The repo-relative entry path of a dotfile URI — what a client joins onto its
 * local checkout of the repo.
 * @param {string} url normalized dotfile URI
 * @returns {string|null}
 */
export function dotfileEntryPath(url) {
    if (typeof url !== 'string') { return null; }
    const hashIndex = url.indexOf('#');
    return hashIndex < 0 ? null : (url.slice(hashIndex + 1) || null);
}
