/**
 * HR routes of the API contract (T3/T4/T5/T6, design §5/§6/§10.2). Bodies mirror the validators exactly
 * (`additionalProperties: false`, same formats and bounds); examples use synthetic data only.
 * `errors` picks the documented error responses of the statuses a route can actually return.
 */
type Errors = (
  statuses: readonly (400 | 401 | 403 | 404 | 409 | 422 | 503)[],
) => Record<string, unknown>;

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
  gender: { type: ['string', 'null'], enum: ['male', 'female', 'other', null] },
  phone: {
    type: ['string', 'null'],
    pattern: '^0[1-9][0-9]{8,9}$',
    description:
      'Canonical national digits; input may carry spaces . - ( ) or a leading +84 (ADR 0028)',
    example: '0901234567',
  },
  workEmail: {
    type: ['string', 'null'],
    maxLength: 254,
    format: 'email',
    description: 'Lowercased on input; contact data only, never a sign-in identity (ADR 0028)',
    example: 'nguyen.van.a@example.com',
  },
});

const position = {
  type: ['string', 'null'],
  minLength: 1,
  maxLength: 100,
  example: 'Kỹ sư phần mềm',
} as const;
const classification = {
  type: ['string', 'null'],
  enum: ['fullTime', 'contractor', null],
} as const;

const ids = {
  employee: '7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f',
  team: '3a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d',
  account: '5f0c2a9e-1b7d-4c3a-9e84-3d6b2f1a7c10',
  request: '9c2e7f1a-5b3d-4a8e-8f6c-0d1e2a3b4c5d',
};

const reason = { type: 'string', minLength: 1, maxLength: 1000, example: 'Việc gia đình' } as const;

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
  position: 'Kỹ sư phần mềm',
  classification: 'fullTime',
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

const month = {
  type: 'string',
  pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$',
  example: '2026-11',
} as const;

const reportPage = (extra: readonly unknown[]) => [...extra, ...page];

/**
 * Report routes (T9, design §6.3): one action per report, scope applied before count and page; each
 * has an `/export` twin (XLSX) on the same action and the same query keys minus the page.
 */
function reportPaths(
  route: (
    summary: string,
    example: unknown,
    statuses: readonly (400 | 401 | 403 | 404 | 409 | 422 | 503)[],
    options?: { parameters?: readonly unknown[] },
  ) => { responses: Record<string, unknown> } & Record<string, unknown>,
) {
  const who = { employeeId: ids.employee, employeeCode: 'NV001', employeeName: 'Nguyễn Văn A' };
  const months = [
    {
      name: 'from',
      in: 'query',
      required: true,
      schema: month,
      description: 'First month, inclusive',
    },
    {
      name: 'to',
      in: 'query',
      required: true,
      schema: month,
      description: 'Last month, inclusive; from ≤ to, at most 12 months',
    },
  ];
  const cutoff = [
    {
      name: 'asOn',
      in: 'query',
      required: true,
      schema: { ...date, example: '2026-11-30' },
      description: 'Cutoff business date, always explicit',
    },
  ];
  const scope =
    'Scope (COO and HR: whole company; employee, Team Lead, CEO: an empty page) is applied inside the read before `total` and the page; an empty page never says whether rows exist outside the scope. No CCCD/MST; no date of birth outside the birthday report, which shows day and month only. One snapshot per request. 400: a missing/unknown/invalid query key or a range over 12 months.';

  const exportNote =
    'XLSX twin of the report: the same action, the same query statement and snapshot (no `limit`/`offset`: a file is the whole scoped set), one flat sheet with Vietnamese headers, typed cells (numbers, dates), no company template; text is always a text cell (a name starting with `=`, `+`, `-` or `@` is not a formula). The caller is authorized again after the file is rendered and before it is delivered (403 `error.accessDenied`, also for a caller with no report role, never an empty file). 422 `error.exportTooLarge`: more than 5000 rows in the caller’s scope or a file over 5 MiB — refused, never cut. Fixed file name from the report and its range; `Cache-Control: no-store`. If the client disconnects nothing more is done and nothing is stored.';

  const entry = (
    path: string,
    action: string,
    what: string,
    parameters: readonly unknown[],
    row: Record<string, unknown>,
  ): [string, { get: unknown }][] => {
    const file = route(
      `${action} (export): ${what} ${exportNote}`,
      undefined,
      [400, 401, 403, 422, 503],
      {
        parameters,
      },
    );
    file.responses[200] = {
      description: 'XLSX attachment',
      headers: {
        'Content-Disposition': {
          schema: {
            type: 'string',
            example: `attachment; filename="hrm-report-${path}-${parameters.length === 1 ? '2026-11-30' : '2026-11_2026-11'}.xlsx"`,
          },
        },
      },
      content: {
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
          schema: { type: 'string', format: 'binary' },
        },
      },
    };
    return [
      [
        `/api/hr/reports/${path}`,
        {
          get: route(
            `${action}: ${what} ${scope}`,
            { kind: path, total: '1', rows: [row] },
            [400, 401, 503],
            { parameters: reportPage(parameters) },
          ),
        },
      ],
      [`/api/hr/reports/${path}/export`, { get: file }],
    ];
  };

  return Object.fromEntries<{ get: unknown }>([
    ...entry(
      'attendance',
      'employee.reportAttendance',
      'attendance sheet in minutes per employee and month (D05, same numbers as GET /employees/{id}/attendance). A month HR closed is read from its stored snapshot (hash re-verified, D07), an open month is computed from live data; `periodState` says which. Ordered by employee code, id, month.',
      months,
      {
        ...who,
        month: '2026-11',
        periodState: 'closed',
        scheduledMinutes: 10080,
        paidHolidayMinutes: 0,
        unpaidMinutes: 120,
        annualLeaveMinutes: 480,
        paidMinutes: 9960,
        wfhDays: 2,
        lateCount: 1,
        lateMinutes: 60,
        earlyCount: 0,
        earlyMinutes: 0,
        adjustmentMinutes: 0,
      },
    ),
    ...entry(
      'late-early',
      'employee.reportLateEarly',
      'approved late arrivals and early departures per employee and month (counted and measured only, D05); closed months from the snapshot.',
      months,
      {
        ...who,
        month: '2026-11',
        periodState: 'open',
        lateCount: 1,
        lateMinutes: 60,
        earlyCount: 0,
        earlyMinutes: 0,
      },
    ),
    ...entry(
      'wfh',
      'employee.reportWfh',
      'approved WFH days per employee and month of the WFH day, never of the approval (D04); `overLimit` = more than 4 days; closed months from the snapshot.',
      months,
      { ...who, month: '2026-11', periodState: 'open', wfhDays: 5, overLimit: true },
    ),
    ...entry(
      'leave',
      'employee.reportLeave',
      'D09 annual leave balance at the cutoff in minutes of its year (entitled, used to the cutoff, approved ahead, pending, available) for employees employed at some time in that year; same numbers as GET /employees/{id}/leave-balance (`annualMinutes` null when not official on the cutoff, ADR 0039).',
      cutoff,
      {
        ...who,
        year: 2026,
        asOn: '2026-11-30',
        annualMinutes: 5760,
        entitledMinutes: 5280,
        usedMinutes: 960,
        futureApprovedMinutes: 480,
        pendingMinutes: 0,
        availableMinutes: 3840,
      },
    ),
    ...entry(
      'seniority',
      'employee.reportSeniority',
      'length of service at the cutoff from the employment dates (hire day and cutoff both count), for employees employed that day.',
      cutoff,
      {
        ...who,
        hiredOn: '2025-01-01',
        asOn: '2026-12-31',
        years: 2,
        months: 0,
        days: 0,
        totalDays: 730,
      },
    ),
    ...entry(
      'birthday',
      'employee.reportBirthday',
      'the day each employee celebrates in each month of `from..to` (T9 part B, design §12.0): 29/02 is shown on 28/02 in a common year and on 29/02 in a leap year; DAY AND MONTH ONLY — the birth year, CCCD and tax code never leave the database, for the COO or HR. Only employees employed that day (hired on or before it, not left before it) with a recorded date of birth. Ordered by day, employee code, id.',
      months,
      { ...who, month: '2027-02', birthdayOn: '2027-02-28' },
    ),
  ]);
}

export function moduleOpenApiPaths(errors: Errors) {
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
    '/api/hr/employees/me': {
      get: route(
        'Own employee link (id, code, full name; `null` for Root or an account without an employee) and the company-scope hint (display only; no role, revision, account or F2). Any signed-in account',
        {
          employee: { id: ids.employee, code: 'NV001', fullName: 'Nguyễn Văn A' },
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
        'hrCompany.createEmployee (fresh): F1, F2 and first status period in one commit; an official hire also gets its first leave rate. `annualLeaveMinutes` is optional and only for `status: official` (default 5760, 12 days, from `hiredOn`); sending it with `probation` is 400, because probation has no leave rate until the official period starts (ADR 0039)',
        { id: ids.employee },
        [400, 401, 403, 409, 503],
        {
          status: 201,
          body: object(
            {
              code: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,32}$', example: 'NV001' },
              fullName: { type: 'string', minLength: 1, maxLength: 200, example: 'Nguyễn Văn A' },
              hiredOn: date,
              status: { type: 'string', enum: ['probation', 'official'] },
              annualLeaveMinutes: minutes,
              identity,
              position,
              classification,
            },
            ['code', 'fullName', 'hiredOn', 'status', 'identity', 'position', 'classification'],
          ),
        },
      ),
    },
    '/api/hr/employees/{id}': {
      parameters: [pathId('id')],
      get: route('employee.read: F1 with status periods and current teams', employeeExample, read),
      patch: route(
        'employee.update: code, full name, position and classification',
        { version: '2' },
        write,
        {
          body: object({
            expectedVersion: version,
            code: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,32}$', example: 'NV001' },
            fullName: { type: 'string', minLength: 1, maxLength: 200, example: 'Nguyễn Văn A' },
            position,
            classification,
          }),
        },
      ),
    },
    '/api/hr/employees/{id}/official': {
      parameters: [pathId('id')],
      post: route(
        'employee.update: probation ends, official from `effectiveOn` (may be a future day). Unless a leave rate dated on or before that day exists, the default rate (5760) is written from it; 409 `error.periodClosed` while a month from that day on is closed (accrual changes back to it, D07) (ADR 0039)',
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
          gender: 'male',
          phone: '0901234567',
          workEmail: 'nguyen.van.a@example.com',
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
    '/api/hr/employees/{id}/leave-balance': {
      parameters: [
        pathId('id'),
        {
          name: 'date',
          in: 'query',
          required: false,
          schema: { type: 'string', format: 'date', example: '2026-11-30' },
          description: 'Report date; default today (Asia/Ho_Chi_Minh, DB clock)',
        },
      ],
      get: route(
        'employee.readLeaveBalance (self, a lead’s members, HR): annual leave of the report date’s year in minutes (D09) — entitled (accrued to the end of the report month, D03: a month counts when official on its 15th, probation never accrues), used (approved, dates up to the report date), approved ahead (later dates), pending (waiting, never a ledger row) and available = entitled − used − ahead − pending, never below 0. `annualMinutes` is the rate in force on the report date, or null when the employee is not official that day (probation has no rate, ADR 0039). Absent and out of scope are the same 404.',
        {
          employeeId: ids.employee,
          year: 2026,
          asOn: '2026-11-30',
          annualMinutes: 5760,
          entitledMinutes: 5280,
          usedMinutes: 720,
          futureApprovedMinutes: 480,
          pendingMinutes: 240,
          availableMinutes: 3840,
        },
        read,
      ),
    },
    '/api/hr/employees/{id}/leave-adjustments': {
      parameters: [pathId('id')],
      post: route(
        'employee.adjustLeaveBalance (HR, fresh session; T8 part B, D07/D14): appends one signed `adjustment` entry to the annual-leave ledger, dated in an open month and not before the hire date; `reference` (where the number comes from) is mandatory. Entries are never edited or deleted; the response is the entry id, never the balance. 400: invalid body (`kind`/employee fields are refused) or key; 403: CSRF or no fresh session; 404: absent or not the caller’s to adjust; 409 `error.conflict`: dated before the hire date; 409 `error.periodClosed`: the month is closed (D07); 422 `error.idempotencyKeyReused`: the key reused with another payload. A retry with the same `Idempotency-Key` and payload returns the first id.',
        { id: ids.team },
        [...write, 422],
        {
          status: 201,
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: {
                type: 'string',
                pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                example: '6d2f0c1e-8a7b-4c3d-9e5f-1a2b3c4d5e6f',
              },
            },
          ],
          body: object({
            minutes: {
              type: 'integer',
              minimum: -175680,
              maximum: 175680,
              not: { const: 0 },
              example: -480,
            },
            effectiveOn: date,
            reference: { type: 'string', minLength: 1, maxLength: 200, example: 'QĐ-2026/03' },
          }),
        },
      ),
    },
    '/api/hr/leave/reconciliation': {
      get: route(
        'employee.readLeaveBalance, scoped to the caller: pending annual-leave requests accepted before the balance check existed that exceed the accrual — per month with pending leave, approved + pending dated up to its end against the entitlement to its end (spec §8). Employees paged by code (`total` counts employees); information for HR only, nothing is cancelled or changed. `year` default: the current year.',
        {
          year: 2026,
          total: '1',
          items: [
            {
              employeeId: ids.employee,
              employeeCode: 'NV001',
              employeeName: 'Nguyễn Văn A',
              month: 3,
              accruedMinutes: 1440,
              approvedMinutes: 0,
              pendingMinutes: 2400,
              excessMinutes: 960,
              requestIds: [ids.request],
            },
          ],
        },
        [400, 401, 403, 503],
        {
          parameters: [
            ...page,
            {
              name: 'year',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1900, maximum: 2100 },
            },
          ],
        },
      ),
    },
    '/api/hr/employees/{id}/attendance': {
      parameters: [
        pathId('id'),
        {
          name: 'month',
          in: 'query',
          required: false,
          schema: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$', example: '2026-11' },
          description: 'Month YYYY-MM; default the current month (Asia/Ho_Chi_Minh, DB clock)',
        },
      ],
      get: route(
        'employee.readAttendance (self, HR): the monthly sheet in minutes (D05), computed from the hire/leaving dates, the calendar version and the approved requests only. scheduled = working minutes of the calendar inside employment; paidHoliday = paid holidays (not working time); unpaid = approved unpaid leave; annualLeave = approved annual leave (recorded, never deducted); paid = scheduled − unpaid + paidHoliday + adjustmentMinutes (HR’s audited paid-minute adjustments of the month, `attendance.adjust`, signed); wfhDays = approved WFH days; late/early = approved late arrival/early departure, counted and measured only (D05), nothing deducted. periodState says whether HR closed the month (D07). Absent and out of scope are the same 404.',
        {
          employeeId: ids.employee,
          month: '2026-11',
          periodState: 'open',
          scheduledMinutes: 10080,
          paidHolidayMinutes: 0,
          unpaidMinutes: 120,
          annualLeaveMinutes: 480,
          paidMinutes: 9960,
          wfhDays: 2,
          lateCount: 1,
          lateMinutes: 60,
          earlyCount: 0,
          earlyMinutes: 0,
          adjustmentMinutes: 0,
        },
        read,
      ),
    },
    '/api/hr/employees/{id}/attendance-adjustments': {
      parameters: [pathId('id')],
      get: route(
        'employee.readAttendanceAdjustment (HR, company scope; `attendance.adjust`, release 15): the entries HR added for one month of one employee, newest day first, with the month’s signed total (`adjustmentMinutes`, as included in the sheet and the snapshot of a closed month), the exact count and `periodState`. Each entry shows its day, signed paid minutes, the mandatory reason and the optional reference — not who added it (the audit trail has who). Page budget as everywhere (`limit` ≤ 100, `offset` ≤ 10000). Absent and out of scope are the same 404.',
        {
          employeeId: ids.employee,
          month: '2026-11',
          periodState: 'open',
          adjustmentMinutes: -60,
          total: '1',
          items: [
            {
              id: ids.team,
              workDate: '2026-11-03',
              minutes: -60,
              reason: 'Quên chấm công buổi chiều',
              reference: 'QĐ-2026/11',
              createdAt: '2026-11-04T03:00:00.000000Z',
            },
          ],
        },
        read,
        {
          parameters: [
            {
              name: 'month',
              in: 'query',
              required: true,
              schema: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$', example: '2026-11' },
            },
            ...page,
          ],
        },
      ),
      post: route(
        'employee.adjustAttendance (HR, fresh session; `attendance.adjust`, release 15; user decision 2026-10-22): appends one signed number of PAID minutes for one employee on one day of their employment — never a per-kind correction, never the leave ledger. `reason` (≤ 300 characters, no personal data or secrets, never audited) is mandatory; `reference` is optional (≤ 64 characters of letters, digits and `. _ / # : -`). The month of `workDate` must be open and the month’s paid total must stay ≥ 0. Entries are never edited or deleted (correct with an entry of the opposite sign); the response is the entry id, never the sheet. 400: invalid body or key (unknown fields such as an employee id or actor are refused); 403: CSRF, no fresh session, or the employee is the one linked to the caller’s own account (nobody adjusts their own attendance; user decision 2026-10-22); 404: absent or not the caller’s to adjust; 409 `error.conflict`: the day is outside the employment period or the month’s paid total would go below zero; 409 `error.periodClosed`: the month is closed (D07); 422 `error.idempotencyKeyReused`: the key reused with another payload. A retry with the same `Idempotency-Key` and payload returns the first id.',
        { id: ids.team },
        [...write, 422],
        {
          status: 201,
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: {
                type: 'string',
                pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                example: '6d2f0c1e-8a7b-4c3d-9e5f-1a2b3c4d5e6f',
              },
            },
          ],
          body: object(
            {
              workDate: { ...date, example: '2026-11-03' },
              minutes: {
                type: 'integer',
                minimum: -1440,
                maximum: 1440,
                not: { const: 0 },
                example: -60,
              },
              reason: {
                type: 'string',
                minLength: 1,
                maxLength: 300,
                example: 'Quên chấm công buổi chiều',
              },
              reference: { type: 'string', minLength: 1, maxLength: 64, example: 'QĐ-2026/11' },
            },
            ['workDate', 'minutes', 'reason'],
          ),
        },
      ),
    },
    '/api/hr/attendance/periods/{month}': {
      parameters: [
        {
          name: 'month',
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$', example: '2026-11' },
        },
      ],
      get: route(
        'hrCompany.read (HR): whether HR closed the month, its version and the history of every close and reopen, newest first (≤ 50): event, resulting version, the mandatory reason of a reopen and the UTC instant — never the snapshot, its hash or the actor (the audit trail has who). A month nobody touched is `open`, version `1`, no events.',
        {
          month: '2026-11',
          state: 'open',
          version: '3',
          events: [
            {
              event: 'reopen',
              version: '3',
              reason: 'Sửa lịch làm bù',
              occurredAt: '2026-12-02T03:00:00.000000Z',
            },
            {
              event: 'close',
              version: '2',
              reason: null,
              occurredAt: '2026-12-01T03:00:00.000000Z',
            },
          ],
        },
        read,
      ),
    },
    ...Object.fromEntries(
      (['close', 'reopen'] as const).map((action) => [
        `/api/hr/attendance/periods/{month}/${action}`,
        {
          parameters: [
            {
              name: 'month',
              in: 'path',
              required: true,
              schema: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$', example: '2026-11' },
            },
          ],
          post: route(
            action === 'close'
              ? 'hrCompany.managePeriod (HR, fresh), D07: closes the month — stores the sheet of every employee with its SHA-256 and refuses (409 `error.periodClosed`) every new request, final approval, calendar change of a day in it. Body: empty object. 409 `error.conflict`: already closed, or a month after the current one.'
              : 'hrCompany.managePeriod (HR, fresh), D07: reopens a closed month with a mandatory reason; the snapshot is dropped, the close/reopen history (actor, reason) stays. 409 `error.conflict`: the month is not closed.',
            { month: '2026-11', state: action === 'close' ? 'closed' : 'open', version: '2' },
            [400, 401, 403, 409, 503],
            action === 'close'
              ? { body: object({}) }
              : { body: object({ reason: { ...reason, example: 'Sửa lịch làm bù' } }) },
          ),
        },
      ]),
    ),
    ...reportPaths(route),
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
        'workCalendar.manage (fresh): a weekday takes `holiday` (name, or null for a standard workday); a Saturday/Sunday takes `makeup` (true: full workday 09:00–13:00, 14:00–18:00; false: weekly rest); the other key is 400; each change is a new calendar version; 409 `error.periodClosed`: the day is in an attendance month HR closed (D07)',
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
    '/api/hr/work-calendar/holidays': {
      put: route(
        'workCalendar.manage (fresh, ADR 0042): paid holiday for every Monday–Friday of from..to (from ≤ to, at most 31 calendar days, may cross a year; Saturdays/Sundays inside are skipped). One transaction, one audit, one calendar version per changed weekday; days that already are this holiday are left alone and the response is the last version. 400: invalid dates, longer than 31 days, or no weekday in the range; 409 `error.conflict`: stale version or nothing to change; 409 `error.periodClosed`: a day is in an attendance month HR closed (D07), nothing is written',
        { version: '6' },
        [400, 401, 403, 409, 503],
        {
          body: object({
            expectedVersion: version,
            from: date,
            to: { ...date, example: '2026-09-03' },
            name: { type: 'string', minLength: 1, maxLength: 200, example: 'Ngày lễ (ví dụ)' },
          }),
        },
      ),
    },
    '/api/hr/requests': {
      get: route(
        'workRequest.read, own requests only: scoped page, newest first; dates and total minutes of the segments',
        {
          items: [
            {
              id: ids.request,
              kind: 'annual-leave',
              state: 'pending_lead',
              version: '1',
              teamId: ids.team,
              createdAt: '2026-11-02T02:00:00.000000Z',
              startDate: '2026-11-03',
              endDate: '2026-11-03',
              minutes: 240,
            },
          ],
          total: '1',
        },
        [400, 401, 403, 503],
        { parameters: page },
      ),
      post: route(
        'employee.submitRequest on the caller’s own profile (never a payload field): late-arrival/early-departure (date + expected minute in a shift), wfh (dates), annual-leave/unpaid-leave (slots 09–11, 11–13, 14–16, 16–18, 09–13, 14–18, 09–18); ≤ 31 working days, one year, dates within [today − 7, today + 90] (Asia/Ho_Chi_Minh); on probation only late/early/unpaid. 400 `error.invalidRequest`: invalid body, an expected time outside a shift, a non-slot interval or a day outside employment; 404: no own profile; 409 `error.overlappingRequest`: overlap with one of the caller’s own pending/approved requests; 409 `error.periodClosed`: a day of the request is in a month HR closed (D07); 409 `error.conflict`: a COO submit while a required effect handler is not registered (fail closed; a COO’s own request is otherwise approved at submit — state `approved`, version 1, system decision `coo_self_approved` — with the effects of a final approval written in the same transaction, §6.4 (1)); 422 with the rule’s key, only after the caller’s own profile is authorized: `error.dateOutOfRange`, `error.crossesYear`, `error.kindNotAllowedInProbation`, `error.teamNotMember` (any team id that is not a current team of the caller, or no primary team), `error.nonWorkingDay` (weekend/holiday), `error.makeupDay` (leave on a makeup day), `error.idempotencyKeyReused` (the key reused with another payload), `error.insufficientLeave` (annual leave: approved + pending + this request, dated up to the end of any month, exceed the leave accrued to the end of it, D03/D09). A retry with the same `Idempotency-Key` and payload returns the first result. A WFH request also answers `wfhLimitExceeded` (D04): true when its days would take a month past 4 approved WFH days — a warning, not a refusal.',
        { id: ids.request, state: 'pending_lead', version: '1', wfhLimitExceeded: false },
        [...write, 422],
        {
          status: 201,
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: {
                type: 'string',
                pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                example: '0b9c7a8e-2f3d-4c1b-9a8e-7d6c5b4a3f21',
              },
            },
          ],
          body: {
            oneOf: [
              object(
                {
                  kind: { type: 'string', enum: ['late-arrival', 'early-departure'] },
                  teamId: nullable(uuid),
                  reason,
                  date,
                  expectedMinute: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1440,
                    description:
                      'Late: 541–780 or 841–1079; early: 541–779 or 841–1079 (minutes of the day)',
                    example: 600,
                  },
                },
                ['kind', 'reason', 'date', 'expectedMinute'],
              ),
              object(
                {
                  kind: { type: 'string', enum: ['wfh'] },
                  teamId: nullable(uuid),
                  reason,
                  dates: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 31,
                    uniqueItems: true,
                    items: date,
                  },
                },
                ['kind', 'reason', 'dates'],
              ),
              object(
                {
                  kind: { type: 'string', enum: ['annual-leave', 'unpaid-leave'] },
                  teamId: nullable(uuid),
                  reason,
                  segments: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 31,
                    items: object({
                      date,
                      startMinute: { type: 'integer', minimum: 0, maximum: 1440, example: 540 },
                      endMinute: { type: 'integer', minimum: 0, maximum: 1440, example: 780 },
                    }),
                  },
                },
                ['kind', 'reason', 'segments'],
              ),
            ],
          },
        },
      ),
    },
    '/api/hr/requests/{id}': {
      parameters: [pathId('id')],
      get: route(
        'workRequest.read: segments and decision history (system decisions included); the COO also reads, with workRequest.readLeadRejected, a lead’s request rejected at the lead step (read only)',
        {
          id: ids.request,
          employeeId: ids.employee,
          teamId: ids.team,
          kind: 'annual-leave',
          state: 'pending_final',
          version: '1',
          reason: 'Việc gia đình',
          createdAt: '2026-11-02T02:00:00.000000Z',
          segments: [{ date: '2026-11-03', startMinute: 540, endMinute: 780, minutes: 240 }],
          decisions: [
            {
              stage: 'lead',
              decision: 'skip',
              actorKind: 'system',
              systemReason: 'lead_skipped_submitter_is_lead',
              reason: null,
              decidedAt: '2026-11-02T02:00:00.000000Z',
            },
          ],
        },
        read,
      ),
    },
    '/api/hr/requests/{id}/cancel': {
      parameters: [pathId('id')],
      post: route(
        'Cancel at the current state (T8 part B, design §6.2, D06/D07). The permission follows the stored state, never the body: pending_lead/pending_final → workRequest.cancel (the owner only), approved → workRequest.cancelApproved (HR, fresh session, mandatory `reason`): annual leave is reversed in the ledger exactly once per debit, the WFH counter goes down and the attendance sheet drops the request (it counts approved requests only). 400: invalid body (`state`/stage/actor fields are refused), key, or an approved request without `reason`; 403: CSRF, or HR without a fresh session; 404: absent, not readable, or not the caller’s to cancel in this state; 409 `error.conflict`: stale `expectedVersion`, no transition from the current state (cancelled/rejected, or the owner’s own approved request); 409 `error.periodClosed`: a day of an approved request is in a month HR closed (D07); 422 `error.idempotencyKeyReused`: the key reused with another payload. A retry with the same `Idempotency-Key` and payload returns the first result while the caller can still read the request.',
        { id: ids.request, state: 'cancelled', version: '4' },
        [...write, 422],
        {
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: {
                type: 'string',
                pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                example: '6d2f0c1e-8a7b-4c3d-9e5f-1a2b3c4d5e6f',
              },
            },
          ],
          body: object(
            {
              expectedVersion: version,
              reason: {
                ...nullable(reason),
                description: 'Required to cancel an approved request; optional for a pending one',
                example: 'HR đảo quyết định',
              },
            },
            ['expectedVersion'],
          ),
        },
      ),
    },
    '/api/hr/requests/{id}/decision': {
      parameters: [pathId('id')],
      post: route(
        'Approve or reject at the current stage (T6, design §6.2–§6.4.1). The stage and its permission follow the stored state, never the body: pending_lead → workRequest.decideLead (the current lead of the request’s team, or of the primary team after leaving it), pending_final → workRequest.decideFinal (COO). Late-arrival/early-departure need the lead only: the lead approval is final. Never one’s own request. A reject needs its reason (D08). 400: invalid body (`stage`/`state`/actor fields are refused) or key; 403: CSRF, one’s own request, or not the current first-step approver; 404: absent, not readable, or a stage the caller may not decide; 409 `error.conflict`: stale `expectedVersion`, no transition from the current state, an effect refused (leave exhausted or not official) or an approval that would reach `approved` while a required effect handler is not registered (fail closed); 409 `error.periodClosed`: a day of the request is in a month HR closed (D07); 409 `error.wfhLimitAckRequired`: an approving WFH request takes a month past 4 WFH days (D04) and `acknowledgeWfhLimit` is not true; 422 `error.idempotencyKeyReused`: the key reused with another payload. A retry with the same `Idempotency-Key` and payload returns the first result while the caller can still read the request.',
        { id: ids.request, state: 'pending_final', version: '2' },
        [...write, 422],
        {
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: {
                type: 'string',
                pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                example: '6d2f0c1e-8a7b-4c3d-9e5f-1a2b3c4d5e6f',
              },
            },
          ],
          body: object(
            {
              expectedVersion: version,
              decision: { type: 'string', enum: ['approve', 'reject'] },
              reason: {
                ...nullable(reason),
                description: 'Required to reject; optional note to approve',
                example: 'Đồng ý',
              },
              acknowledgeWfhLimit: {
                type: 'boolean',
                default: false,
                description:
                  'D04: the final approver saw that this WFH approval takes a month past 4 WFH days',
              },
            },
            ['expectedVersion', 'decision'],
          ),
        },
      ),
    },
    ...Object.fromEntries(
      (['lead', 'final'] as const).map((stage) => [
        `/api/hr/approvals/${stage}`,
        {
          get: route(
            stage === 'lead'
              ? 'workRequest.decideLead: pending_lead requests waiting for the caller as their current Team Lead, never the caller’s own; scoped page, oldest first'
              : 'workRequest.decideFinal: pending_final requests waiting for the final decision (COO), never the caller’s own; scoped page, oldest first',
            {
              items: [
                {
                  id: ids.request,
                  employeeId: ids.employee,
                  kind: 'wfh',
                  state: stage === 'lead' ? 'pending_lead' : 'pending_final',
                  version: stage === 'lead' ? '1' : '2',
                  teamId: ids.team,
                  createdAt: '2026-11-02T02:00:00.000000Z',
                  startDate: '2026-11-03',
                  endDate: '2026-11-03',
                  minutes: 480,
                },
              ],
              total: '1',
            },
            [400, 401, 403, 503],
            { parameters: page },
          ),
        },
      ]),
    ),
    '/api/hr/approvals/decided': {
      get: route(
        'workRequest.readDecided: requests decided in the caller’s approval scope — the lead’s requests as their current first-step approver (the COO’s decisions included), the whole company for the COO — never the caller’s own; decided = approved or rejected, or with a person’s lead/final decision; each with the owner’s full name (employeeName, only for rows the caller may read) and its latest lead/final decision (no reason, no decider); scoped page, latest decision first. Without an approval right the page is empty.',
        {
          items: [
            {
              id: ids.request,
              employeeId: ids.employee,
              employeeName: 'Nguyễn Văn An',
              kind: 'wfh',
              state: 'rejected',
              version: '3',
              teamId: ids.team,
              createdAt: '2026-11-02T02:00:00.000000Z',
              startDate: '2026-11-03',
              endDate: '2026-11-03',
              minutes: 480,
              decision: {
                stage: 'final',
                decision: 'reject',
                actorKind: 'user',
                decidedAt: '2026-11-03T03:00:00.000000Z',
              },
            },
          ],
          total: '1',
        },
        [400, 401, 403, 503],
        { parameters: page },
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
