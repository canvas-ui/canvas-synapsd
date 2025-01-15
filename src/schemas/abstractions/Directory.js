import Document from '../Document.js';

class Directory extends Document {
    constructor(options = {}) {
        super(options);
        this.type = 'directory';
        this.children = options.children || [];
    }

    addChild(child) {
        this.children.push(child);
        this.updated_at = new Date().toISOString();
    }

    removeChild(childId) {
        this.children = this.children.filter(child => child.id !== childId);
        this.updated_at = new Date().toISOString();
    }

    listChildren() {
        return this.children;
    }
}

export default Directory;
