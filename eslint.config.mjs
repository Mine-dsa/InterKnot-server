import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Pragmatic baseline for a large, pre-existing Strapi codebase.
 *
 * Philosophy: the lint step must be GREEN today so it can gate future PRs.
 * Genuine-bug rules are `error`; the large existing type-safety debt
 * (explicit `any`, etc.) is surfaced as `warn` so it's visible without
 * blocking. Tighten these to `error` as the debt is paid down.
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'dist/',
      'build/',
      '.cache/',
      '.tmp/',
      'types/generated/',
      'public/',
      'agent-worker/',
      'scripts/',
      '**/*.js',
      '**/*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { strapi: 'readonly', process: 'readonly' },
    },
    rules: {
      // Type-safety debt: visible but non-blocking for now.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Pre-existing patterns across the Strapi codebase: surfaced, not blocking.
      // (dynamic `require()` in a few spots; harmless regex escapes.)
      '@typescript-eslint/no-require-imports': 'warn',
      'no-useless-escape': 'warn',
      // Genuine bugs: hard errors.
      'no-cond-assign': 'error',
      'no-dupe-keys': 'error',
      'no-unsafe-negation': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-debugger': 'error',
      eqeqeq: ['warn', 'smart'],
      // Strapi lifecycles/controllers rely on the ambient `strapi` global.
      'no-undef': 'off',
    },
  },
  prettier,
);
