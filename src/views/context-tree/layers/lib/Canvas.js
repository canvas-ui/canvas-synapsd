import Layer from './Layer.js';

export default class Canvas extends Layer {
    constructor(options = {}) {
        super(options);
        this.type = 'canvas';

        // Canvas stores feature and filter bitmaps
        this.featureBitmaps = [];
        this.filterBitmaps = [];

        // Canvas stores ACL and UI data
        this.acl = options.acl ?? {};
        this.ui = options.ui ?? {}; // Layout data
    }

    /**
     * Getters
     */

    get featureBitmapArray() {
        return this.featureBitmaps;
    }

    get filterBitmapArray() {
        return this.filterBitmaps;
    }

    /**
     * Bitmaps
     */

    insertFeatureBitmap(bitmap) {
        this.featureBitmaps.push(bitmap);
    }

    removeFeatureBitmap(bitmap) {
        this.featureBitmaps = this.featureBitmaps.filter((b) => b !== bitmap);
    }

    clearFeatureBitmaps() {
        this.featureBitmaps = [];
    }

    insertFilterBitmap(bitmap) {
        this.filterBitmaps.push(bitmap);
    }

    removeFilterBitmap(bitmap) {
        this.filterBitmaps = this.filterBitmaps.filter((b) => b !== bitmap);
    }

    clearFilterBitmaps() {
        this.filterBitmaps = [];
    }

    /**
     * ACL
     */

    insertUser(user, permissions) {
        this.acl.users.push({ user, permissions });
    }

    removeUser(user) {
        this.acl.users = this.acl.users.filter((u) => u.user !== user);
    }

    /**
     * JSON
     */

    toJSON() {
        // TODO: Maybe we should use JSON.stringify to return a valid JSON directly
        return {
            schemaVersion: this.schemaVersion,
            id: this.id,
            type: this.type,
            name: this.name,
            label: this.label,
            description: this.description,
            color: this.color,
            locked: this.locked,
            metadata: this.metadata,
            featureBitmaps: this.featureBitmaps,
            filterBitmaps: this.filterBitmaps,
            acl: this.acl,
            ui: this.ui,
        };
    }

    static fromJSON(json) {
        // TODO: Maybe we should use JSON string as input and then JSON.parse it
        const layer = new Layer({
            schemaVersion: json.schemaVersion,
            id: json.id,
            type: json.type,
            name: json.name,
            label: json.label,
            description: json.description,
            color: json.color,
            locked: json.locked,
            metadata: json.metadata,
            featureBitmaps: json.featureBitmaps,
            filterBitmaps: json.filterBitmaps,
            acl: json.acl,
            ui: json.ui,
        });
        return layer;
    }
}
