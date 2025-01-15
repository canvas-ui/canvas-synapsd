import Document from '../Document.js';

class Tab extends Document {
    constructor(options = {}) {
        super(options);
        this.type = 'tab';
        this.title = options.title || '';
        this.url = options.url || '';
    }

    updateTitle(newTitle) {
        this.title = newTitle;
        this.updated_at = new Date().toISOString();
    }

    updateUrl(newUrl) {
        this.url = newUrl;
        this.updated_at = new Date().toISOString();
    }
}

export default Tab;
