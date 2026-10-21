import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import formatConfig from './eslint.format.config.js';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**'] },
  ...formatConfig,
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] },
          ],
        },
      ],
    },
  },
  {
    files: ['**/eslint*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);

// ADR 0033: business logic files stay within 300 non-blank, non-comment lines.
// Declarative data files are exempt; tests live outside src.
export function fileSizeLimit(temporaryExceptions) {
  return [
    {
      files: ['src/**/*.{ts,tsx}'],
      ignores: ['**/*.declarations.ts', '**/*.schema.ts', '**/*.migration.ts', '**/*.manifest.ts'],
      rules: { 'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }] },
    },
    ...(temporaryExceptions.length > 0
      ? [{ files: temporaryExceptions, rules: { 'max-lines': 'off' } }]
      : []),
  ];
}
