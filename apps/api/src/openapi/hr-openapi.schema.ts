/**
 * HR routes of the API contract (T3/T4, design §5/§10.2). Bodies mirror the validators exactly
 * (`additionalProperties: false`, same formats and bounds); examples use synthetic data only.
 * `errors` picks the documented error responses of the statuses a route can actually return.
 */
type Errors = (statuses: readonly (400 | 401 | 403 | 404 | 409 | 503)[]) => Record<string, unknown>;

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date', example: '2026-10-01' } as const;
const version = {
  type: 'string',
  pattern: '^[1-9][0-9]{0,17}$',
  description: 'Optimistic version (int8 as decimal string)',
  example: '1',
} as const;
const minutes = {
  type: 'integer',
  minimum: 5760,
  maximum: 175680,
  description: 'Annual leave in minutes (480 = 1 day, 5760 = 12 days)',
  example: 5760,
} as const;

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

const nullable = (schema: Record<string, unknown>) => ({ ...schema, type: [schema.type, 'null'] });

const identity = object({
  dateOfBirth: nullable(date),
  documentKind: { type: ['string', 'null'], enum: ['cccd', 'cmnd', 'passport', null] },
  documentNumber: {
    type: ['string', 'null'],
    pattern: '^[A-Z0-9]{6,20}$',
    example: '001090000001',
  },
  taxCode: {
    type: ['string', 'null'],
    pattern: '^[0-9]{10,13}(-[0-9]{3})?$',
    example: '0100000001',
  },
});

const ids = {
  employee: '7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f',
  team: '3a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d',
  account: '5f0c2a9e-1b7d-4c3a-9e84-3d6b2f1a7c10',
};

const person = { employeeId: ids.employee, code: 'NV001', fullName: 'Nguyễn Văn A' };

const employeeExample = {
  id: ids.employee,
  code: 'NV001',
  fullName: 'Nguyễn Văn A',
  hiredOn: '2026-09-01',
  terminatedOn: null,
  state: 'probation',
  version: '1',
  accountId: ids.account,
  periods: [{ status: 'probation', startsOn: '2026-09-01', endsOn: null }],
  teams: [{ id: ids.team, name: 'Kỹ thuật', primary: true, since: '2026-09-01T02:00:00.000000Z' }],
};

const teamExample = {
  id: ids.team,
  name: 'Kỹ thuật',
  version: '1',
  lead: person,
  members: [{ ...person, primary: true, since: '2026-09-01T02:00:00.000000Z' }],
  leadHistory: [{ ...person, startsAt: '2026-09-01T02:00:00.000000Z', endsAt: null }],
};

const pathId = (name: string) => ({ name, in: 'path', required: true, schema: uuid });

const page = [
  {
    name: 'limit',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
  {
    name: 'offset',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 0, maximum: 10000, default: 0 },
  },
];

export function hrOpenApiPaths(errors: Errors) {
  const route = (
    summary: string,
    example: unknown,
    statuses: Parameters<Errors>[0],
    options: { body?: unknown; status?: 200 | 201; parameters?: readonly unknown[] } = {},
  ) => ({
    summary,
    security: [{ sessionCookie: [] }],
    ...(options.parameters ? { parameters: options.parameters } : {}),
    ...(options.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: options.body } },
          },
        }
      : {}),
    responses: {
      [options.status ?? 200]: {
        description: 'Success',
        content: { 'application/json': { example } },
      },
      ...errors(statuses),
    },
  });

  const read = [400, 401, 403, 404, 503] as const;
  const write = [400, 401, 403, 404, 409, 503] as const;

  return {
    '/api/hr/me': {
      get: route(
        'Own employee profile link, server-granted menus and the company-scope hint (display only; no role, revision or F2)',
        {
          userId: ids.account,
          employee: { id: ids.employee, code: 'NV001', fullName: 'Nguyễn Văn A' },
          menus: ['employees', 'teams', 'calendar'],
          companyScope: true,
        },
        [400, 401, 503],
      ),
    },
    '/api/hr/employees': {
      get: route(
        'employee.read: scoped page ordered by code; `search` matches code or name literally',
        {
          items: [
            {
              id: ids.employee,
              code: 'NV001',
              fullName: 'Nguyễn Văn A',
              state: 'probation',
              primaryTeam: { id: ids.team, name: 'Kỹ thuật' },
            },
          ],
          total: '1',
        },
        [400, 401, 403, 503],
        {
          parameters: [
            ...page,
            {
              name: 'search',
              in: 'query',
              required: false,
              schema: { type: 'string', maxLength: 100 },
            },
          ],
        },
      ),
      post: route(
        'hrCompany.createEmployee (fresh): F1, F2, first status period and first leave rate in one commit',
        { id: ids.employee },
        [400, 401, 403, 409, 503],
        {
          status: 201,
          body: object({
            code: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,32}$', example: 'NV001' },
            fullName: { type: 'string', minLength: 1, maxLength: 200, example: 'Nguyễn Văn A' },
            hiredOn: date,
            status: { type: 'string', enum: ['probation', 'official'] },
            annualLeaveMinutes: minutes,
            identity,
          }),
        },
      ),
    },
    '/api/hr/employees/{id}': {
      parameters: [pathId('id')],
      get: route('employee.read: F1 with status periods and current teams', employeeExample, read),
      patch: route('employee.update: code and full name', { version: '2' }, write, {
        body: object({
          expectedVersion: version,
          code: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,32}$', example: 'NV001' },
          fullName: { type: 'string', minLength: 1, maxLength: 200, example: 'Nguyễn Văn A' },
        }),
      }),
    },
    '/api/hr/employees/{id}/official': {
      parameters: [pathId('id')],
      post: route(
        'employee.update: probation ends, official from `effectiveOn`',
        { version: '2' },
        write,
        {
          body: object({ effectiveOn: date }),
        },
      ),
    },
    '/api/hr/employees/{id}/termination': {
      parameters: [pathId('id')],
      post: route('employee.update: last working day (inclusive)', { version: '2' }, write, {
        body: object({ terminatedOn: date }),
      }),
    },
    '/api/hr/employees/{id}/identity': {
      parameters: [pathId('id')],
      get: route(
        'employeeIdentity.read (F2): own record or HR',
        {
          employeeId: ids.employee,
          version: '1',
          dateOfBirth: '1990-01-01',
          documentKind: 'cccd',
          documentNumber: '001090000001',
          taxCode: '0100000001',
        },
        read,
      ),
      put: route(
        'employeeIdentity.update (F2, fresh): replaces every F2 field',
        { version: '2' },
        write,
        {
          body: object({ expectedVersion: version, identity }),
        },
      ),
    },
    '/api/hr/employees/{id}/leave-rates': {
      parameters: [pathId('id')],
      get: route(
        'leaveRate.read (F3): visible rates of the employee, newest first (≤ 100)',
        { items: [{ id: ids.team, effectiveFrom: '2026-09-01', annualMinutes: 5760 }] },
        [400, 401, 403, 503],
      ),
      post: route(
        'employee.adjustLeaveRate (F3, fresh): adds a rate from `effectiveFrom`',
        { id: ids.team },
        write,
        {
          status: 201,
          body: object({ effectiveFrom: date, annualMinutes: minutes }),
        },
      ),
    },
    '/api/hr/employees/{id}/account': {
      parameters: [pathId('id')],
      put: route(
        'employee.linkAccount (fresh, boundary required): link an IAM account, or unlink with null; never the caller’s own',
        { version: '2' },
        write,
        { body: object({ expectedVersion: version, accountId: nullable(uuid) }) },
      ),
    },
    '/api/hr/teams': {
      get: route(
        'team.read: scoped page ordered by name with current lead and member count',
        { items: [{ id: ids.team, name: 'Kỹ thuật', lead: person, memberCount: 1 }], total: '1' },
        [400, 401, 403, 503],
        { parameters: page },
      ),
      post: route(
        'hrCompany.createTeam: a team without members',
        { id: ids.team },
        [400, 401, 403, 409, 503],
        {
          status: 201,
          body: object({
            name: { type: 'string', minLength: 1, maxLength: 200, example: 'Kỹ thuật' },
          }),
        },
      ),
    },
    '/api/hr/teams/{id}': {
      parameters: [pathId('id')],
      get: route('team.read: members, current lead and lead history', teamExample, read),
      patch: route('team.update: rename (unique ignoring case)', { version: '2' }, write, {
        body: object({
          expectedVersion: version,
          name: { type: 'string', minLength: 1, maxLength: 200, example: 'Kỹ thuật' },
        }),
      }),
    },
    '/api/hr/teams/{id}/members': {
      parameters: [pathId('id')],
      post: route(
        'team.assign (fresh, boundary required): add a member; the first team is primary',
        { status: 'added' },
        write,
        { body: object({ employeeId: uuid, primary: { type: 'boolean' } }) },
      ),
    },
    '/api/hr/teams/{id}/members/{employeeId}': {
      parameters: [pathId('id'), pathId('employeeId')],
      delete: route(
        'team.assign (fresh, boundary required): end a membership; a primary one only when it is the last',
        { status: 'ended' },
        write,
      ),
    },
    '/api/hr/teams/{id}/members/{employeeId}/primary': {
      parameters: [pathId('id'), pathId('employeeId')],
      post: route(
        'team.assign (fresh, boundary required): make this the primary team',
        { status: 'primary' },
        write,
      ),
    },
    '/api/hr/work-calendar': {
      get: route(
        'workCalendar.read: paid holidays and makeup workdays (Saturday/Sunday, same shifts) of one year at the current calendar version (standard week Mon–Fri 09:00–13:00, 14:00–18:00)',
        {
          version: '3',
          year: 2026,
          holidays: [{ date: '2026-09-02', name: 'Ngày lễ (ví dụ)' }],
          makeupDays: ['2026-08-29'],
        },
        read,
        {
          parameters: [
            {
              name: 'year',
              in: 'query',
              required: true,
              schema: { type: 'integer', minimum: 1900, maximum: 2100, example: 2026 },
            },
          ],
        },
      ),
    },
    '/api/hr/work-calendar/days/{date}': {
      parameters: [{ name: 'date', in: 'path', required: true, schema: date }],
      put: route(
        'workCalendar.manage (fresh): a weekday takes `holiday` (name, or null for a standard workday); a Saturday/Sunday takes `makeup` (true: full workday 09:00–13:00, 14:00–18:00; false: weekly rest); the other key is 400; each change is a new calendar version',
        { version: '4' },
        [400, 401, 403, 409, 503],
        {
          body: {
            oneOf: [
              object({
                expectedVersion: version,
                holiday: {
                  type: ['string', 'null'],
                  minLength: 1,
                  maxLength: 200,
                  example: 'Ngày lễ (ví dụ)',
                },
              }),
              object({ expectedVersion: version, makeup: { type: 'boolean', example: true } }),
            ],
          },
        },
      ),
    },
    '/api/hr/teams/{id}/lead': {
      parameters: [pathId('id')],
      put: route(
        'team.assign (fresh, boundary required): replace the lead, or none with null; never the caller',
        { status: 'assigned' },
        write,
        { body: object({ employeeId: nullable(uuid) }) },
      ),
    },
  };
}
