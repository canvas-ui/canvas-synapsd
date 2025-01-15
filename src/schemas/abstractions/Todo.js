import Document from '../Document.js';

class Todo extends Document {
    constructor(options = {}) {
        super(options);
        this.type = 'todo';
        this.title = options.title || '';
        this.description = options.description || '';
        this.dueDate = options.dueDate || null;
        this.completed = options.completed || false;
    }

    updateTitle(newTitle) {
        this.title = newTitle;
        this.updated_at = new Date().toISOString();
    }

    updateDescription(newDescription) {
        this.description = newDescription;
        this.updated_at = new Date().toISOString();
    }

    updateDueDate(newDueDate) {
        this.dueDate = newDueDate;
        this.updated_at = new Date().toISOString();
    }

    markAsCompleted() {
        this.completed = true;
        this.updated_at = new Date().toISOString();
    }

    markAsIncomplete() {
        this.completed = false;
        this.updated_at = new Date().toISOString();
    }
}

export default Todo;
