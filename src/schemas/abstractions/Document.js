'use strict';

import BaseDocument, { documentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/document';
const DOCUMENT_SCHEMA_VERSION = '2.0';

export default class Document extends BaseDocument {
    constructor(options = {}) {
        super(options);
    }

    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Document(data);
    }
}