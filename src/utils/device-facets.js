'use strict';

/**
 * Device facet keys.
 *
 * `device/*` is the MACHINE axis: which box holds a copy, and what that box is.
 * (`data/backend/*` is the separate addressing question — how the bytes are
 * reached.) A document is tagged with the facets of every device it is actually
 * present on, resolved through that device's own `data/schema/device` document.
 * The Device row is the single source of truth; these keys are a queryable
 * projection of it, and the same projection tags the Device document itself
 * (Device.getFeatureBitmapArray).
 *
 * Only `device/id/*` comes from the location URL. Everything below is OPTIONAL
 * ENRICHMENT that appears once a Device document exists — an unregistered device
 * contributes its id and nothing else.
 */

import { normalizeBitmapKey } from '../indexes/bitmaps/lib/keys.js';

/**
 * Canonicalize an OS FAMILY. Accepts node's `process.platform` spellings and
 * common aliases.
 *
 * Unknown input passes through unchanged rather than being forced into a known
 * family: a client reporting something this does not know about should produce a
 * key that is merely unfamiliar, not a wrong one. Note the corollary — a client
 * that reports `ubuntu` here (instead of `linux` + `osDistro: 'ubuntu'`) gets
 * `device/os/ubuntu`, outside the linux subtree. Report `os.platform()`.
 *
 * @param {string} value
 * @returns {string|null}
 */
export function normalizeDeviceOs(value) {
    const input = String(value || '').trim().toLowerCase();
    if (!input) { return null; }
    if (input === 'darwin' || input === 'macos' || input === 'osx') { return 'mac'; }
    if (input === 'win32' || input === 'win' || input === 'windows_nt') { return 'windows'; }
    return input;
}

/**
 * Canonicalize a device type (laptop, desktop, server, phone, …).
 * @param {string} value
 * @returns {string|null}
 */
export function normalizeDeviceType(value) {
    const input = String(value || '').trim().toLowerCase();
    return input || null;
}

// One tier is ONE segment. A '/' inside a value would silently deepen the chain
// — osDistro 'ubuntu/core' becoming two tiers, arch 'linux/x86_64' becoming a
// nested key — so it is folded away rather than trusted. This is the only shape
// rule enforced here, and it is enforced because it is the only one that can be
// stated without a registry of known operating systems (see deviceFacetKeys).
const segment = (value) => {
    const input = String(value ?? '').trim().toLowerCase().replace(/\//g, '_');
    return input || null;
};

/**
 * The queryable facet keys for a device, from its Device document's data.
 *
 * The OS is a CHAIN — family, distro, version — and every prefix is ticked, the
 * same roll-up contract as `data/mime/*` and `data/backend/*`:
 *
 *   device/os/linux
 *   device/os/linux/ubuntu
 *   device/os/linux/ubuntu/24.04
 *
 * so "everything on Linux", "everything on Ubuntu" and "everything on the boxes
 * we have not migrated off 22.04 yet" are each a single key with no enumeration.
 *
 * The rule is positional only in the loose sense — each tier narrows the one
 * before it, most general first, and an empty tier is skipped rather than
 * reserved. Families with no distro tier therefore get a shorter chain,
 * `device/os/mac/15.2` and `device/os/windows/11`, which is the point: "still on
 * Windows 10" deserves an answer as much as "still on 22.04" does.
 *
 * NOT ENFORCED, deliberately. Requiring `linux/<distro>/<version>` means a
 * registry of which families have which tiers, and that registry is wrong the
 * first time someone shows up with a buildroot image — while being useless for
 * exactly that case, since a custom distro reports an ID like any other and
 * already lands correctly as `linux/iolinux/1.2`. The only shape it would
 * actually police is a client reporting a version with no distro, which yields
 * `device/os/linux/24.04`. That key is inert — nobody queries a key they cannot
 * construct — and the client is broken; surfacing that beats rejecting the write
 * or silently discarding the version it did report. What IS enforced is arity:
 * a tier cannot contain '/' and therefore cannot become two tiers (see segment).
 *
 * The engine stays dumb about operating systems for the same reason it stays
 * dumb about backends — it parses a shape, and the vocabulary is the caller's.
 *
 * Arch is `os.machine()` vocabulary (`x86_64`, `aarch64`), not `os.arch()`
 * (`x64`, `arm64`), because that is what flatpak, snap and appimage publish
 * against — so a capability facet and a device facet can be compared without a
 * translation table.
 *
 * @param {object} deviceData `doc.data` of a data/schema/device document
 * @returns {string[]} normalized bitmap keys, id excluded
 */
export function deviceFacetKeys(deviceData = {}) {
    const keys = [];

    const chain = [
        segment(normalizeDeviceOs(deviceData.platform ?? deviceData.deviceOs ?? deviceData.os)),
        segment(deviceData.osDistro ?? deviceData.distro),
        segment(deviceData.osVersion ?? deviceData.distroVersion),
    ].filter(Boolean);
    let path = 'device/os';
    for (const part of chain) {
        path += `/${part}`;
        keys.push(path);
    }

    const arch = segment(deviceData.arch ?? deviceData.machine);
    if (arch) { keys.push(`device/arch/${arch}`); }

    const type = normalizeDeviceType(deviceData.type ?? deviceData.deviceType);
    if (type) { keys.push(`device/type/${type}`); }

    // Normalized here rather than at each call site: a distro version like
    // "22.04 LTS" is legitimate input and an illegal key.
    return keys.map(normalizeBitmapKey);
}

/**
 * The full identity key set for a Device document — its own id plus its facets.
 * Self-referential by design: the row for device foo describes foo, which is what
 * makes "show me my Ubuntu 24.04 boxes" resolvable without a scan.
 *
 * @param {object} deviceData `doc.data` of a data/schema/device document
 * @returns {string[]}
 */
export function deviceSelfKeys(deviceData = {}) {
    const deviceId = segment(deviceData?.deviceId);
    return [
        ...(deviceId ? [normalizeBitmapKey(`device/id/${deviceId}`)] : []),
        ...deviceFacetKeys(deviceData),
    ];
}
