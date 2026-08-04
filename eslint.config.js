import js from '@eslint/js';
import globals from 'globals';

// Flat config (eslint 9). Replaces a `.eslintrc.json` that eslint 9 never read —
// and that, in the eslintrc era, would have linted nothing either: its
// ignorePatterns were copy-pasted from the parent repo and included
// `**/src/services/synapsd/**`, i.e. this package ignoring itself. `npm run lint`
// has been failing with "all files are ignored" ever since.
const IGNORE_PATTERNS = [
    'node_modules/**',
    'coverage/**',
    'models/**',
];

// Style rules are WARN, correctness rules are ERROR (via js.configs.recommended).
// The split is the point: `npm run lint` should fail on something that is wrong,
// not on a long line. Values match the house style already in the code — 4-space
// indent, single quotes, trailing commas, semicolons.
const STYLE_RULES = {
    indent: ['warn', 4, { SwitchCase: 1 }],
    quotes: ['warn', 'single', { avoidEscape: true }],
    semi: ['warn', 'always'],
    'comma-dangle': ['warn', 'always-multiline'],
    'linebreak-style': ['warn', 'unix'],
    curly: ['warn', 'all'],
    // `x == null` (matches null OR undefined) is used deliberately throughout and
    // is the correct idiom for it — every eqeqeq hit in this repo was that pattern,
    // so flagging it would be a config bug reported as 28 code bugs.
    eqeqeq: ['warn', 'always', { null: 'ignore' }],
    'no-var': 'warn',
    'prefer-const': 'warn',
};

export default [
    { ignores: IGNORE_PATTERNS },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: { ...globals.node, ...globals.es2024 },
        },
        rules: {
            ...STYLE_RULES,
            'no-console': 'off',
            // `catch { }` as a deliberate ignore is idiomatic here (probe-style
            // reads), and unused args are marked with a leading underscore.
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],
        },
    },
];
