'use strict';

// Utils
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:synapses');

/**
 * Synapses - Inverted index for bidirectional Document <-> Layer linking
 *
 * Manages the "Reverse Index" (DocID -> LayerID[]) while keeping the
 * "Forward Index" (LayerID -> Bitmap[DocID]) in sync via BitmapIndex.
 */
export default class Synapses {

    constructor(dataset, bitmapIndex) {
        if (!dataset) { throw new Error('Synapses dataset required'); }
        if (!bitmapIndex) { throw new Error('BitmapIndex instance required'); }

        this.dataset = dataset; // LMDB store: DocID (uint32) -> JSON Array of strings
        this.bitmapIndex = bitmapIndex;
        debug('Synapses index initialized');
    }

    /**
     * Link a document to one or more layers.
     * Updates both the reverse index (Synapses) and forward index (Bitmaps).
     *
     * @param {number} docId - Document ID
     * @param {string|string[]} layerIds - Single layer ID or array of layer IDs
     * @returns {Promise<boolean>} True on success
     */
    async createSynapses(docId, layerIds) {
        if (!docId) { throw new Error('Document ID required'); }
        const layers = Array.isArray(layerIds) ? layerIds : [layerIds];
        if (layers.length === 0) { return false; }

        debug(`createSynapses: Linking doc ${docId} to ${layers.length} layers`);

        // 1. Update Forward Index (Bitmaps)
        // This ensures that context/feature queries find the document
        await this.bitmapIndex.tickMany(layers, docId);

        // 2. Update Reverse Index (Synapses)
        // This ensures we know where the document lives
        const existingLayers = await this.listSynapses(docId);

        // Merge new layers with existing ones (Set Union)
        const uniqueLayers = new Set([...existingLayers, ...layers]);

        // Only write if there's a change
        if (uniqueLayers.size > existingLayers.length) {
            const newLayerList = Array.from(uniqueLayers);
            await this.dataset.put(docId, newLayerList);
            debug(`createSynapses: Updated doc ${docId} reverse index. Total layers: ${newLayerList.length}`);
        }

        return true;
    }

    /**
     * "Magical" Link - Inherit layer memberships from related documents.
     *
     * @param {number} docId - Target Document ID to link
     * @param {number[]} relatedDocIds - Source Document IDs to copy from
     * @returns {Promise<number>} Count of new links created
     */
    async createSynapsesFromDocs(docId, relatedDocIds) {
        if (!docId || !Array.isArray(relatedDocIds) || relatedDocIds.length === 0) {
            return 0;
        }

        debug(`createSynapsesFromDocs: Inheriting layers for doc ${docId} from ${relatedDocIds.length} docs`);

        // Collect all layers from all related docs
        const collectedLayers = new Set();

        for (const relatedId of relatedDocIds) {
            const layers = await this.listSynapses(relatedId);
            for (const layer of layers) {
                collectedLayers.add(layer);
            }
        }

        if (collectedLayers.size === 0) {
            debug('createSynapsesFromDocs: No layers found to inherit');
            return 0;
        }

        const layersArray = Array.from(collectedLayers);
        await this.createSynapses(docId, layersArray);

        return layersArray.length;
    }

    /**
     * Get all layers a document belongs to.
     *
     * @param {number} docId
     * @returns {Promise<string[]>} Array of layer IDs
     */
    async listSynapses(docId) {
        if (!docId) { return []; }

        const layers = await this.dataset.get(docId);
        return Array.isArray(layers) ? layers : [];
    }

    /**
     * Unlink a document from specific layers.
     *
     * @param {number} docId
     * @param {string|string[]} layerIds
     */
    async removeSynapses(docId, layerIds) {
        if (!docId) { return; }
        const layersToRemove = Array.isArray(layerIds) ? layerIds : [layerIds];
        if (layersToRemove.length === 0) { return; }

        debug(`removeSynapses: Removing doc ${docId} from ${layersToRemove.length} layers`);

        // 1. Update Forward Index (Bitmaps)
        await this.bitmapIndex.untickMany(layersToRemove, docId);

        // 2. Update Reverse Index (Synapses)
        const currentLayers = await this.listSynapses(docId);
        if (currentLayers.length === 0) { return; }

        const layersToRemoveSet = new Set(layersToRemove);
        const newLayerList = currentLayers.filter(layer => !layersToRemoveSet.has(layer));

        if (newLayerList.length !== currentLayers.length) {
            if (newLayerList.length === 0) {
                await this.dataset.remove(docId);
                debug(`removeSynapses: Doc ${docId} removed from all layers, entry deleted`);
            } else {
                await this.dataset.put(docId, newLayerList);
                debug(`removeSynapses: Updated doc ${docId} reverse index. Remaining layers: ${newLayerList.length}`);
            }
        }
    }

    /**
     * Completely unlink a document from ALL layers.
     * Used when deleting a document.
     *
     * @param {number} docId
     */
    async clearSynapses(docId) {
        if (!docId) { return; }

        const currentLayers = await this.listSynapses(docId);
        if (currentLayers.length === 0) { return; }

        debug(`clearSynapses: Unlinking doc ${docId} from all ${currentLayers.length} layers`);

        // 1. Update Forward Index (Bitmaps)
        // This is more efficient than iterating individually if untickMany is optimized
        await this.bitmapIndex.untickMany(currentLayers, docId);

        // 2. Delete Reverse Index Entry
        await this.dataset.remove(docId);
    }
}

