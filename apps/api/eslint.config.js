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
    importNames: ['provisionProductDatabase', 'productDataSourceOptions', 'productMigrations'],
    message: 'Provisioning and migration are offline tools only.',
  },
];

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
                '**/auth/**',
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
    // Business modules (ADR 0031) are covered only for their HTTP files; their services,
    // repositories, helpers and declarations may use TypeORM and ProductAuthorization.
    files: [
      'src/{auth,document,administration,health,openapi}/**/*.ts',
      'src/modules/**/*.{controller,http-port,module}.ts',
    ],
    ignores: ['src/document/migrations/**', 'src/auth/services/**'],
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
                '**/auth/services/**',
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
              message: 'Identity service operations are private; inject AUTH_HTTP_PORT.',
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
    // Root access uses the factory-issued plan only (ADR 0012); the factory owns the raw planner.
    // Core unit tests exercise both directly. Developer boundary, not process isolation.
    files: ['**/*.ts'],
    ignores: [
      'src/authorization/services/product-authority.service.ts',
      'src/authorization/core/authorization.factory.ts',
      'test/core/**',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='planUnrestricted']",
          message: 'Only ProductAuthorization.access may plan unrestricted access (ADR 0012).',
        },
        {
          selector: "ObjectPattern > Property[key.name='planUnrestricted']",
          message: 'Only ProductAuthorization.access may plan unrestricted access (ADR 0012).',
        },
        {
          selector: "ImportSpecifier[imported.name='planUnrestricted']",
          message:
            'The unrestricted planner is internal to the core factory and authority service.',
        },
        {
          selector:
            "ExportNamedDeclaration[source] > ExportSpecifier[local.name='planUnrestricted']",
          message:
            'The unrestricted planner is internal to the core factory and authority service.',
        },
      ],
    },
  },
  // shortcut: nền tảng lớn chưa tách (ADR 0033), tách khi chạm tới file để sửa logic; xóa dòng tương ứng khi file <= 300 dòng.
  ...fileSizeLimit([
    'src/auth/services/product-mfa.service.ts',
    'src/authorization/core/policy.validator.ts',
    'src/authorization/services/product-authority.service.ts',
    'src/database/helpers/product-database.helper.ts',
  ]),
];
