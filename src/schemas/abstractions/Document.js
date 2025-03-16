'use strict';

import BaseDocument from '../BaseDocument.js';

export default class Document extends BaseDocument {
    constructor(options = {}) {
        super(options);
    }

    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Document(data);
    }
}