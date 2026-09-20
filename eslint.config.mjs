import otoTelemetry from './packages/telemetry/eslint/index.mjs';
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
  {
    // A log line is written once and read when something has already gone
    // wrong, which is the worst moment to discover it carries a phone number
    // or a child's medical note. The redactor in @oto/telemetry catches these
    // at runtime; this catches them at the keyboard, where they are cheap to
    // fix. Deliberately NOT listing : it is the error code on every
    // envelope we send and the SQLSTATE on every pg error, so a rule that
    // fired on it would be switched off within a week - the redactor, which
    // can see the value, still refuses a six-digit one.
    files: ['**/*.ts', '**/*.mjs'],
    plugins: { oto: otoTelemetry },
    rules: { 'oto/no-pii-in-logs': 'error' },
  },
);
