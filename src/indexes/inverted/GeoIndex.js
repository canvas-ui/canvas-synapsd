'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:geo-index');
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Roaring = require('roaring');
const { RoaringBitmap32 } = Roaring;
const s2 = require('nodes2ts');

import BitSlicedIndex from '../bitmaps/lib/BitSlicedIndex.js';

// One point-style BSI over the full S2 cell id (unsigned 64-bit BigInt fits the
// 64-bit slice depth verbatim — no sign encoding). Containment is an id-range:
// every ancestor cell covers the contiguous [rangeMin, rangeMax] interval of
// its descendants, so "in cell X" at ANY level is a single BETWEEN — the bitmap
// population stays fixed at the slice width (~64 + ebm) regardless of data
// density or which levels queries use.
//
// Lossy by design: the index answers candidate-set questions only; rendering
// reads raw GPS from doc metadata (metadata.geo). Stored ids are capped at
// LEVEL 21 (~5 m) — GPS accuracy is 3–10 m, finer cells would be fake
// precision (same stance as the timeline scales).
const LEVEL = 21;
const EARTH_RADIUS_M = 6371010;
const DEFAULT_MAX_CELLS = 20;

export default class GeoIndex {

    #bsi;

    constructor(bitmapIndex) {
        if (!bitmapIndex) { throw new Error('BitmapIndex required for GeoIndex'); }
        this.#bsi = new BitSlicedIndex('internal/geo/s2', bitmapIndex, 64);
        this.bitmapIndex = bitmapIndex;
        debug(`GeoIndex initialized (S2 level ${LEVEL} point BSI)`);
    }

    static cellIdFor(lat, lon) {
        const point = s2.S2LatLng.fromDegrees(lat, lon).toPoint();
        return s2.S2CellId.fromPoint(point).parentL(LEVEL).id;   // BigInt (unsigned)
    }

    // ── Writes ────────────────────────────────────────────────────────────────

    async insert(id, lat, lon) {
        if (id === undefined || id === null) { throw new Error('ID required for geo insert'); }
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) { throw new Error('Numeric lat/lon required'); }
        const cellId = GeoIndex.cellIdFor(lat, lon);
        await this.#bsi.setValue(id, cellId);
        debug(`Set ID ${id} @ ${lat},${lon} → cell ${cellId}`);
        return true;
    }

    async remove(id) {
        if (id === undefined || id === null) { return false; }
        await this.#bsi.removeValue(id);
        return true;
    }

    /** Membership probe on the existence bitmap — cheap guard before remove(). */
    async has(id) {
        const ebm = await this.bitmapIndex.getBitmap(this.#bsi.ebmKey, false);
        return !!ebm && ebm.has(Number(id));
    }

    async getCount() {
        const ebm = await this.bitmapIndex.getBitmap(this.#bsi.ebmKey, false);
        return ebm ? ebm.size : 0;
    }

    // ── Queries (all return RoaringBitmap32) ──────────────────────────────────

    /** Union of BETWEEN range queries, one per covering cell. */
    async queryCells(cellIds) {
        const union = new RoaringBitmap32();
        for (const cid of cellIds) {
            const cell = cid instanceof s2.S2CellId ? cid : new s2.S2CellId(BigInt(cid));
            const hits = await this.#bsi.query('BETWEEN', [cell.rangeMin().id, cell.rangeMax().id]);
            union.orInPlace(hits);
        }
        return union;
    }

    /** Docs inside a lat/lon bounding box (mapbox viewport). */
    async queryBBox(minLat, minLon, maxLat, maxLon, options = {}) {
        const rect = s2.S2LatLngRect.fromLatLng(
            s2.S2LatLng.fromDegrees(minLat, minLon),
            s2.S2LatLng.fromDegrees(maxLat, maxLon),
        );
        return await this.#queryRegion(rect, options);
    }

    /** Docs within radiusMeters of a point (spherical cap covering). */
    async queryRadius(lat, lon, radiusMeters, options = {}) {
        if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) { throw new Error('Positive radiusMeters required'); }
        const center = s2.S2LatLng.fromDegrees(lat, lon).toPoint();
        const cap = s2.S2Cap.fromAxisAngle(center, s2.S1Angle.radians(radiusMeters / EARTH_RADIUS_M));
        return await this.#queryRegion(cap, options);
    }

    async #queryRegion(region, { maxCells = DEFAULT_MAX_CELLS } = {}) {
        const coverer = new s2.S2RegionCoverer();
        coverer.setMaxCells(maxCells);
        const cells = coverer.getCoveringCells(region);
        debug(`region covering: ${cells.length} cells (levels ${cells.map(c => c.level()).join(',')})`);
        return await this.queryCells(cells);
    }
}

export { LEVEL as GEO_S2_LEVEL };
