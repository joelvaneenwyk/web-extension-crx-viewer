
import ts from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import functional from 'eslint-plugin-functional';
import imprt from 'eslint-plugin-import'; // 'import' is ambiguous & prettier has trouble
import globals from "globals";

export default [
  {
    parser: tsParser,
    parserOptions: {
      ecmaFeatures: { modules: true },
      ecmaVersion: 'latest',
      project: './tsconfig.json',
    },
    plugins: {
      functional,
      import: imprt,
      '@typescript-eslint': ts,
      ts,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    files: ["**/*.js", "**/*.mjs", "**/*.ts"],
    rules: {
      ...ts.configs['eslint-recommended'].rules,
      ...ts.configs['recommended'].rules,
      semi: ["error", "always"]
    }
  }
];
