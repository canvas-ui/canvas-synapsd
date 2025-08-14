export default {
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transform: {},
  testEnvironment: 'node',
  testMatch: [
    '**/tests/**/*.test.js'
  ]
};