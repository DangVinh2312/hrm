import reactHooks from 'eslint-plugin-react-hooks';
import sharedConfig, { fileSizeLimit } from '../../eslint.shared.config.js';

export default [
  ...sharedConfig,
  {
    files: ['**/*.{ts,tsx}'],
    ...reactHooks.configs.flat['recommended-latest'],
  },
  ...fileSizeLimit([]),
];
