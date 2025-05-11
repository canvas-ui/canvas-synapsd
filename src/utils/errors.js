'use strict';

/**
 * Base error class for SynapsD
 */
class SynapsDError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Document validation error
 */
class ValidationError extends SynapsDError {
    constructor(message, details = null) {
        super(message);
        this.details = details;
    }
}

/**
 * Document not found error
 */
class NotFoundError extends SynapsDError {
    constructor(message, id = null) {
        super(message);
        this.id = id;
    }
}

/**
 * Document already exists error
 */
class DuplicateError extends SynapsDError {
    constructor(message, id = null) {
        super(message);
        this.id = id;
    }
}

/**
 * Database operation error
 */
class DatabaseError extends SynapsDError {
    constructor(message, operation = null) {
        super(message);
        this.operation = operation;
    }
}

export {
    SynapsDError,
    ValidationError,
    NotFoundError,
    DuplicateError,
    DatabaseError
};
