import Db from '../src/backends/lmdb/index.js'
import ContextTree from '../src/views/tree/index.js'

const db = new Db({
    path: '/tmp/testdb10'
})

const dataset = db.createDataset('internal');

const tree = new ContextTree({
    dataStore: dataset,
})

async function test() {
    await tree.initialize();
    console.log(tree.paths);

    await tree.insertPath('/test/test2');
    await tree.insertPath('/foo/bar/baz/baf');
    await tree.insertPath('/fo2/bar/baz/baf');
    await tree.insertPath('/fzzz/dwq/baz/dqwdw');
    console.log(tree.paths);

    //await tree.removePath('/foo2/bar/baz/baf');


    console.log('=========================================');
    console.log(JSON.stringify(tree.buildJsonTree(), null, 2));
    console.log('=========================================');


}

test();

