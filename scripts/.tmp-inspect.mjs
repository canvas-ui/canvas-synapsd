import { open } from 'lmdb';
const env = open({ path: process.argv[2], maxDbs: 64, compression: true });
const internal = env.openDB('internal');
const documents = env.openDB('documents');
console.log('schemaVersion raw:', JSON.stringify(internal.get('internal/schemaVersion')));
let rows = 0; const sample = new Map();
for (const { value } of documents.getRange()) { rows++; if (value?.schema) sample.set(value.schema, (sample.get(value.schema) || 0) + 1); }
console.log('rows:', rows, 'schemas:', JSON.stringify([...sample.entries()]));
await env.close();
