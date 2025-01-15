import Document from '../Document.js';

class File extends Document {
    constructor(options = {}) {
        super(options);
        this.type = 'file';
        this.size = options.size || 0;
        this.extension = options.extension || '';
    }

    updateSize(newSize) {
        this.size = newSize;
        this.updated_at = new Date().toISOString();
    }

    updateExtension(newExtension) {
        this.extension = newExtension;
        this.updated_at = new Date().toISOString();
    }
}

export default File;
