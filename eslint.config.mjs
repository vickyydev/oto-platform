import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      // The ported prototype UI keeps its original style; linted separately later.
      'apps/pos/**',
      '**/migrations/**',
      // Raw Replit exports are reference material, never part of the build.
      'imports/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Repo tooling scripts run on Node 22 (global fetch/FormData/Blob included).
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    rules: {
      // `any` requires a justifying comment per engineering standards — surfaced
      // as a warning so the comment + suppression are deliberate.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
