import Db from '../src/backends/lmdb/index.js'
import LayerIndex from '../src/views/tree/lib/LayerIndex.js'

const db = new Db({
    path: '/tmp/testdb8'
})

const dataset = db.createDataset('internal');

const layerIndex = new LayerIndex(dataset);


async function test() {
    await layerIndex.initializeIndex();
    const layer2 = await layerIndex.createLayer('test2');
    console.log('layer2', layer2);
    const layer3 = await layerIndex.createLayer('test3', {type: 'canvas'});
    console.log('layer3', layer3);
}

test();

