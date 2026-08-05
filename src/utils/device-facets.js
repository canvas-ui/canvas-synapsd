'use strict';

/**
 * Device facet normalization.
 *
 * `device/os/<os>` and `device/type/<type>` are DERIVED facets: a document is
 * tagged with the OS/type of the devices it is actually present on, resolved
 * through that device's own `data/schema/device` document. The Device doc
 * is the single source of truth; these keys are a queryable projection of it.
 *
 * NOTE: deliberately mirrors `canvas-server/src/utils/device-features.js` so the
 * two producers of `device/os|type/*` agree on spelling — synapsd is a
 * standalone package and cannot import from the parent. Keep them in sync: a
 * divergence here means a client-asserted tag and a derived tag for the same
 * machine land in different bitmaps.
 */

/**
 * Canonicalize an OS string. Accepts node's `process.platform` spellings and
 * common aliases.
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

/**
 * Extract the queryable facets from a Device document's data payload.
 * @param {object} deviceData `doc.data` of a data/schema/device document
 * @returns {{os: string|null, type: string|null}}
 */
export function deviceFacetsFromData(deviceData = {}) {
    return {
        os: normalizeDeviceOs(deviceData.platform ?? deviceData.deviceOs ?? deviceData.os),
        type: normalizeDeviceType(deviceData.type ?? deviceData.deviceType),
    };
}
