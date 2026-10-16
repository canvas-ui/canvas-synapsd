// Native faults must stay in this disposable process, never in the server.
import { open } from 'lmdb';
import { createHash } from 'node:crypto';

const [action, source, destination] = process.argv.slice(2);
const db = open({ path: source, noSubdir: false, readOnly: true, create: false, maxDbs: 256,
    compression: false, encoding: 'binary', keyEncoding: 'binary' });
try {
    if (action === 'copy') {
        await db.backup(destination, true);
        process.stdout.write('{}');
    } else if (action === 'verify') {
        const datasets = {};
        // The main database contains the named-database descriptors. Discover
        // them rather than silently omitting future stores from validation.
        // Opening a named database renews LMDB's read transaction. Finish the
        // root cursor first; keeping it alive across openDB invalidates it.
        const names = Array.from(db.getKeys(), key => key.toString('utf8').replace(/\0$/, ''));
        for (const name of names) {
            const store = db.openDB(name, { create: false, encoding: 'binary', keyEncoding: 'binary' });
            if (!store) { throw new Error(`Missing dataset: ${name}`); }
            const hash = createHash('sha256');
            let count = 0;
            for (const { key, value } of store.getRange()) {
                const sizes = Buffer.alloc(8);
                sizes.writeUInt32LE(key.length); sizes.writeUInt32LE(value.length, 4);
                hash.update(sizes).update(key).update(value);
                count++;
            }
            if (count !== store.getStats().entryCount) { throw new Error(`Incomplete dataset: ${name}`); }
            datasets[name] = { count, sha256: hash.digest('hex') };
        }
        process.stdout.write(JSON.stringify({ datasets }));
    } else { throw new Error('Unknown backup worker action'); }
} finally { await db.close(); }
