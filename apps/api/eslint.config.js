import sharedConfig, { fileSizeLimit } from '../../eslint.shared.config.js';

const driverImports = [
  {
    group: ['typeorm', 'typeorm/*', 'pg', 'pg-*'],
    message: 'Storage drivers belong to services/database, never HTTP handlers or the pure core.',
  },
];

const offlineImports = [
  {
    group: ['**/product-root.service*', '**/product-root-lifecycle.service*'],
    importNames: [
      'bootstrapProductRoot',
      'reissueRootActivation',
      'revokeProductRoot',
      'setRootEmail',
    ],
    message: 'Root lifecycle commands are offline tools only.',
  },
  {
    group: ['**/product-database.helper*'],
    importNames: ['productDataSourceOptions', 'productMigrations'],
    message: 'Provisioning and migration are offline tools only.',
  },
  {
    group: ['**/product-database-provision.service*'],
    importNames: ['provisionProductDatabase'],
    message: 'Provisioning and migration are offline tools only.',
  },
];

const unrestrictedMessage = 'Only ProductAuthorization.access may plan unrestricted access.';
const internalPlannerMessage =
  'The unrestricted planner is internal to the core factory and authority service.';

const unrestrictedPlanSelectors = [
  { selector: "MemberExpression[property.name='planUnrestricted']", message: unrestrictedMessage },
  {
    selector: "ObjectPattern > Property[key.name='planUnrestricted']",
    message: unrestrictedMessage,
  },
  {
    selector: "ImportSpecifier[imported.name='planUnrestricted']",
    message: internalPlannerMessage,
  },
  {
    selector: "ExportNamedDeclaration[source] > ExportSpecifier[local.name='planUnrestricted']",
    message: internalPlannerMessage,
  },
];

const syncHelperMessage =
  'Helpers must be synchronous; async effects belong to repositories or services.';

const syncHelperSelectors = [
  'FunctionDeclaration[async=true]',
  'FunctionExpression[async=true]',
  'ArrowFunctionExpression[async=true]',
  'AwaitExpression',
  'ForOfStatement[await=true]',
  // Covers Promise<T>, new Promise and Promise.* alike.
  "Identifier[name='Promise']",
].map((selector) => ({ selector, message: syncHelperMessage }));

export default [
  ...sharedConfig,
  {
    // Offline functions stay in the same app source, but HTTP runtime cannot import them.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: offlineImports,
        },
      ],
    },
  },
  {
    // The provisioner is the offline entrypoint itself; it composes the options and migration list.
    files: ['src/database/services/product-database-provision.service.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['src/authorization/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?:[^.]|\\.\\./)',
              message: 'Authorization core uses only its own pure source modules.',
            },
            {
              group: [
                '**/values/**',
                '**/services/**',
                '**/enforcement/**',
                '**/database/**',
                '**/authentication/**',
                '**/audit/**',
              ],
              message:
                'Authorization core must remain independent of application services and adapters.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/authorization/enforcement/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...driverImports, ...offlineImports] }],
    },
  },
  {
    // HTTP handlers receive bound operations; services may use TypeORM directly.
    // Business modules are covered only for their HTTP files; their services,
    // repositories, helpers and declarations may use TypeORM and ProductAuthorization.
    files: [
      'src/{authentication,document,administration,health,openapi}/**/*.ts',
      'src/modules/**/*.{controller,http-port,module}.ts',
    ],
    ignores: [
      'src/document/migrations/**',
      'src/administration/migrations/**',
      'src/authentication/services/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...driverImports,
            {
              group: [
                '**/database/**',
                '**/audit/**',
                '**/authorization/services/**',
                '**/authorization/helpers/**',
                '**/authorization/repositories/**',
                '**/product-data.gateway*',
                '**/product-sql.compiler*',
              ],
              allowTypeImports: true,
              message:
                'HTTP handlers use bound facade operations; implementation types may be imported without runtime access.',
            },
            {
              group: [
                '**/authentication/services/**',
                '**/services/product-identity.service*',
                '**/services/product-oidc.service*',
              ],
              allowTypeImports: true,
              allowImportNames: [
                'rateLimitClient',
                'canonicalLoginEmail',
                'ProductAuthenticationError',
                'ProductAuthenticationUnavailable',
              ],
              message: 'Identity service operations are private; inject AUTHENTICATION_HTTP_PORT.',
            },
            {
              group: [
                '**/infrastructure/product-runtime*',
                '**/infrastructure/runtime.module*',
                '**/product-runtime*',
              ],
              message: 'The runtime provider is private to RuntimeModule; inject a facade token.',
            },
          ],
        },
      ],
    },
  },
  {
    // Root access uses the factory-issued plan only; the factory owns the raw planner.
    // Core unit tests exercise both directly. Developer boundary, not process isolation.
    files: ['**/*.ts'],
    ignores: [
      'src/authorization/services/product-authority.service.ts',
      'src/authorization/core/authorization.factory.ts',
      'test/core/**',
    ],
    rules: { 'no-restricted-syntax': ['error', ...unrestrictedPlanSelectors] },
  },
  {
    // Helpers are synchronous; async effects belong to repositories/services.
    // no-restricted-syntax is last-config-wins, so this block repeats the planUnrestricted
    // selectors (no helper is exempt from them) and adds the async ones.
    files: ['src/**/*.helper.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...unrestrictedPlanSelectors, ...syncHelperSelectors],
    },
  },
  // shortcut: nền tảng lớn chưa tách, tách khi chạm tới file để sửa logic; xóa dòng tương ứng khi file <= 300 dòng.
  // product-authority.service.ts còn ~605 dòng logic sau khi tách lệnh account: còn đọc facts, session/plan, access/list/update/execute/query và các interface command; tách tiếp (facts repository, types) khi chạm tới, không dồn lệnh mới vào đây.
  ...fileSizeLimit([
    'src/authentication/services/product-mfa.service.ts',
    'src/authorization/core/policy.validator.ts',
    'src/authorization/services/product-authority.service.ts',
  ]),
];
