export default {
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    transform: {},
    testEnvironment: 'node',
    testMatch: [
        '**/tests/**/*.test.js',
    ],
    // Serialize suites: each opens its own LMDB + native LanceDB instance, and
    // running them in parallel workers races the one-time embedding-model
    // download / concurrent lance handles into a native (Napi) abort + core dump.
    // One worker is plenty for this suite size and keeps `npm test` stable.
    maxWorkers: 1,
};