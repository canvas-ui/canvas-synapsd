import Layer from './Layer.js';

export default class WorkspaceLayer extends Layer {
    constructor(options = {}) {
        super(options);
        this.type = 'workspace';

        // Workspace reference
        this.workspaceReference = options.workspaceReference;
        this.acl = options.acl ?? {};

        // Update layer properties based on workspace config
        this.fetchWorkspaceConfig();
    }

    /**
     * Workspace methods
     */

    getWorkspaceReference() {
        return this.workspaceReference;
    }

    setWorkspaceReference(workspaceReference) {
        this.workspaceReference = workspaceReference;
    }

    fetchWorkspaceConfig() {
        this.name = this.workspaceReference.name;
        this.label = this.workspaceReference.label;
        this.description = this.workspaceReference.description;
        this.color = this.workspaceReference.color;
        this.metadata = this.workspaceReference.metadata;
    }

    // Honestly, not sure how to deal with this yet, probably we'll just work with the ref instead
    // of reimplementing all the workspace methods here
    getWorkspaceTree() {
        return this.workspaceReference.tree;
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
            acl: json.acl,
            ui: json.ui,
        });
        return layer;
    }

    /**
     * Insert a Canvas layer at the specified path
     * @param {string} path - Parent path where to insert the canvas
     * @param {string} canvasName - Name of the canvas
     * @param {Object} canvasOptions - Additional canvas options
     * @returns {string} - ID of the created canvas layer
     */
    insertCanvas(path, canvasName, canvasOptions = {}) {
        debug(`Inserting canvas "${canvasName}" at path "${path}"`);

        // Create the canvas layer with the canvas type
        const canvasLayer = this.tree.createLayer({
            name: canvasName,
            type: 'canvas',
            ...canvasOptions
        });

        // Generate the full path
        const canvasPath = path === '/' ? `/${canvasName}` : `${path}/${canvasName}`;

        // Insert the layer into the tree
        this.tree.insertPath(canvasPath);

        // Emit an event
        this.emit('workspace:canvas:created', {
            path: canvasPath,
            name: canvasName,
            id: canvasLayer.id
        });

        return canvasLayer.id;
    }

    /**
     * Insert a Workspace reference at the specified path
     * @param {string} path - Parent path where to insert the workspace
     * @param {string} workspaceName - Name of the workspace reference
     * @param {string} targetWorkspaceId - ID of the target workspace
     * @param {Object} workspaceOptions - Additional workspace options
     * @returns {string} - ID of the created workspace layer
     */
    insertWorkspace(path, workspaceName, targetWorkspaceId, workspaceOptions = {}) {
        debug(`Inserting workspace reference "${workspaceName}" at path "${path}"`);

        // Create the workspace layer with the workspace type
        const workspaceLayer = this.tree.createLayer({
            name: workspaceName,
            type: 'workspace',
            metadata: {
                targetWorkspaceId
            },
            ...workspaceOptions
        });

        // Generate the full path
        const workspacePath = path === '/' ? `/${workspaceName}` : `${path}/${workspaceName}`;

        // Insert the layer into the tree
        this.tree.insertPath(workspacePath);

        // Emit an event
        this.emit('workspace:workspace:created', {
            path: workspacePath,
            name: workspaceName,
            id: workspaceLayer.id,
            targetId: targetWorkspaceId
        });

        return workspaceLayer.id;
    }

    insertPath(path) {
        return this.tree.insertPath(path);
    }

    removePath(path, recursive) {
        return this.tree.removePath(path, recursive);
    }
}
