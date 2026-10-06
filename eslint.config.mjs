import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', 'artifacts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts,vue}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { parser: tseslint.parser }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-unused-vars': 'off'
    }
  }
];
