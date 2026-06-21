'use strict';

import crypto from 'crypto';

function generateChecksum(data, algorithm = 'sha1') {
    return crypto.createHash(algorithm).update(data).digest('hex');
}

function generateChecksumFromObject(object, algorithm = 'sha1') {
    return generateChecksum(JSON.stringify(object), algorithm);
}

export {
    generateChecksum,
    generateChecksumFromObject,
};
