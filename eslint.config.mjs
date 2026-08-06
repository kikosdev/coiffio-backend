import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2021,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Volontairement minimal (Prompt 9) : le but est un pipeline lint qui BLOQUE sur de
      // vraies erreurs (variables non déclarées, syntaxe invalide), pas d'imposer un style
      // rétroactivement sur ~15k lignes jamais lintées jusqu'ici. Durcir ce ruleset est un
      // travail séparé, délibérément hors scope de ce prompt.
      'no-undef': 'off', // TypeScript s'en charge déjà, plus fiable qu'ESLint ici
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-const-assign': 'error',
    },
  },
];
