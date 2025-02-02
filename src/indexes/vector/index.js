import * as lancedb from "@lancedb/lancedb";


/*
const db = await lancedb.connect("data/sample-lancedb");
const table = await db.createTable("my_table", [
  { id: 1, vector: [0.1, 1.0], item: "foo", price: 10.0 },
  { id: 2, vector: [3.9, 0.5], item: "bar", price: 20.0 },
]);
const results = await table.vectorSearch([0.1, 0.3]).limit(20).toArray();
console.log(results);
*/

export default class VectorIndex {

    constructor(options = {}) {
        if (!options.rootPath) { throw new Error('A rootPath option is required'); }
        this.rootPath = options.rootPath;
    }

    async initialize() {
        this.db = await lancedb.connect(this.rootPath);
    }

    async createTable(tableName, schema) {
        this.table = await this.db.createTable(tableName, schema);
    }

    async listTables() {
        return this.db.listTables();
    }

    async deleteTable(tableName) {
        await this.db.dropTable(tableName);
    }
}
