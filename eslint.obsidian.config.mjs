import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      // The directory scanner currently omits this advisory rule from scorecards.
      'obsidianmd/ui/sentence-case': 'off',
      'no-restricted-imports': ['error', { patterns: ['node:*', 'fs', 'path', 'crypto', 'child_process', 'simple-git'] }],
      'no-restricted-globals': ['error', 'Buffer', 'process', 'require'],
    },
  },
  globalIgnores([
    'node_modules',
    'dist',
    'build',
    'pkg',
    'test-vault',
    '.obsidian',
    '**/.obsidian/**',
    '**/tests/**',
    '**/scripts/**',
    '**/docs/**',
    'artifacts/**',
    'test-results/**',
    '.test-profile/**',
    'test-repository/**',
  ]),
]);
