/**
 * TreeNode CS101 class
 */

export default class TreeNode {
    constructor(id, payload) {
        if (!id) {
            throw new Error('Treenode ID not provided');
        }
        if (typeof id !== 'string') {
            throw new Error(`TreeNode ID must be of type string, "${typeof id}" given`);
        }

        if (!payload) {
            throw new Error('TreeNode payload must be provided');
        }
        if (typeof payload !== 'object') {
            throw new Error(`TreeNode payload must be of type object, "${typeof payload}" given`);
        }

        this.id = id;
        this.payload = payload;
        this.children = new Map();
    }

    get isLeaf() {
        return this.children.size === 0;
    }
    get hasChildren() {
        return !this.isLeaf;
    }
    get name() {
        return this.payload.name;
    }

    getChild(id) {
        return this.children.get(id);
    }

    hasChild(id) {
        return this.children.has(id);
    }

    addChild(child) {
        if (!(child instanceof TreeNode)) {
            throw new Error(`Child must be an instance of TreeNode, "${typeof child}" given`);
        }

        if (!this.hasChild(child.id)) {
            this.children.set(child.id, child);
        }
        return true;
    }

    removeChild(id) {
        return this.children.delete(id);
    }
}
