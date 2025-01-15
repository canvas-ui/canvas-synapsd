import Document from '../Document.js';

class Note extends Document {
    constructor(options = {}) {
        super(options);
        this.type = 'note';
        this.title = options.title || '';
        this.content = options.content || '';
    }

    updateTitle(newTitle) {
        this.title = newTitle;
        this.updated_at = new Date().toISOString();
    }

    updateContent(newContent) {
        this.content = newContent;
        this.updated_at = new Date().toISOString();
    }
}

export default Note;
