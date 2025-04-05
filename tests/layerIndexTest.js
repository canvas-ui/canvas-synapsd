import Db from '../src/backends/lmdb/index.js'
import LayerIndex from '../src/views/tree/lib/LayerIndex.js'

const db = new Db({
    path: '/tmp/testdb8'
})

const dataset = db.createDataset('internal');

const layerIndex = new LayerIndex(dataset);


async function test() {
    await layerIndex.initializeIndex();
}

test();

