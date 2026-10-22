// SPDX-License-Identifier: MIT
//
// ESLint flat config: eslint:recommended plus the "possible problems" rules
// gjs.guide recommends for GJS / GNOME Shell code.

import js from '@eslint/js';

const gjsGlobals = {
    ARGV: 'readonly',
    console: 'readonly',
    global: 'readonly', // GNOME Shell only
    globalThis: 'readonly',
    imports: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
};

export default [
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: gjsGlobals,
        },
        rules: {
            'array-callback-return': 'error',
            'no-await-in-loop': 'error',
            'no-constant-binary-expression': 'error',
            'no-constructor-return': 'error',
            'no-new-native-nonconstructor': 'error',
            'no-promise-executor-return': 'error',
            'no-self-compare': 'error',
            'no-template-curly-in-string': 'error',
            'no-unmodified-loop-condition': 'error',
            'no-unreachable-loop': 'error',
            'no-unused-private-class-members': 'error',
            'no-use-before-define': ['error', {functions: false, classes: true, variables: true, allowNamedExports: true}],
            'no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
            'prefer-const': 'error',
            'no-var': 'error',
            'eqeqeq': ['error', 'always'],
        },
    },
    {
        // Test and dev scripts are scripted sequences by nature.
        files: ['tests/**/*.js', 'scripts/**/*.js'],
        rules: {'no-await-in-loop': 'off'},
    },
    {
        ignores: ['node_modules/', 'dist/', 'PATHFINDER-*/'],
    },
];
