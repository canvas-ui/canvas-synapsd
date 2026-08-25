'use strict';

import Document, { documentSchema } from '../Document.js';
import { deviceSelfKeys } from '../../utils/device-facets.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/schema/device';
const DOCUMENT_SCHEMA_VERSION = '3.0';

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    data: z.object({
        deviceId: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        // OS as a chain: family from `os.platform()`, then the distro and its
        // version, which is the axis a fleet actually differs along — 22.04 and
        // 24.04 are not interchangeable targets. Both optional: a mac reports a
        // version and no distro, an unknown box reports neither.
        platform: z.string().optional(),
        osDistro: z.string().optional(),     // /etc/os-release ID, e.g. 'ubuntu'
        osVersion: z.string().optional(),    // VERSION_ID, e.g. '24.04'
        // `os.machine()` vocabulary (x86_64 / aarch64), NOT `os.arch()` — see
        // deviceFacetKeys.
        arch: z.string().optional(),
        type: z.string().optional(),
        // Identity fields for human-friendly URL addressing
        username: z.string().optional(),
        hostname: z.string().optional(),
        fqdn: z.string().optional(),      // fully-qualified domain name when available
        alias: z.string().optional(),     // user@hostname — authority component for file:// URLs
        createdAt: z.string().optional(),
        lastSeen: z.string().optional(),
    }).passthrough(),
    metadata: z.object({}).passthrough().optional(),
});

export default class Device extends Document {

    // Index configuration is SCHEMA-level, resolved by Document from this
    // static. Never stored on the row (see documentSchema).
    static indexOptions = {
        ftsSearchFields: ['data.name', 'data.deviceId', 'data.alias', 'data.hostname', 'data.description'],
        vectorEmbeddingFields: ['data.name', 'data.alias'],
        checksumFields: ['data.deviceId'],
    };

    constructor(options = {}) {
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = DOCUMENT_SCHEMA_VERSION;

        super(options);
    }

    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Device(data);
    }

    static get dataSchema() {
        return documentDataSchema;
    }

    static get schema() {
        return documentSchema;
    }

    static validate(document) {
        return documentSchema.parse(document);
    }

    static validateData(documentData) {
        return documentDataSchema.parse(documentData);
    }

    /**
     * A Device document carries its OWN identity keys, so "show me my Ubuntu
     * 24.04 boxes" is `data/schema/device AND device/os/linux/ubuntu/24.04`
     * rather than a scan.
     *
     * Derived here rather than asserted by the caller for the usual reason, plus
     * a specific one: `device/*` is dropped and replayed by rebuildL3, and the
     * replay derives device keys from `locations[]` — which a Device row does not
     * have pointing at itself. Asserted self-tags were bitmap-only and a rebuild
     * would delete them with nothing to put them back. Routing them through the
     * facet plane gives them the stale-diff (an OS upgrade unticks 22.04) and the
     * replay for free.
     */
    static getFeatureBitmapArray(deviceDocument) {
        return deviceSelfKeys(deviceDocument?.data || deviceDocument || {});
    }
}

