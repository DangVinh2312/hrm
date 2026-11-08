import { z } from 'zod';
import type { HttpClient } from '../../infrastructure/http.client';
import { type Frame, frameSchema, weekSchema } from '../../components/week-frames.helper';

/** Business date `YYYY-MM-DD` as the API sends it; never parsed through a local timezone. */
const day = z.iso.date();
const version = z.string().regex(/^[1-9][0-9]{0,17}$/);
const state = z.enum(['probation', 'official', 'notStarted', 'terminated']);
export type EmploymentState = z.infer<typeof state>;

export type DocumentKind = 'cccd' | 'cmnd' | 'passport';

const classification = z.enum(['fullTime', 'contractor']).nullable();
const gender = z.enum(['male', 'female', 'other']).nullable();

const summarySchema = z.object({
  id: z.uuid(),
  code: z.string(),
  fullName: z.string(),
  state,
  primaryTeam: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});
const listSchema = z.object({ items: z.array(summarySchema).max(100), total: z.string() });
export type EmployeeList = z.infer<typeof listSchema>;

const employeeSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  fullName: z.string(),
  hiredOn: day,
  terminatedOn: day.nullable(),
  state,
  version,
  accountId: z.uuid().nullable(),
  position: z.string().nullable(),
  classification,
  periods: z.array(
    z.object({
      status: z.enum(['probation', 'official']),
      startsOn: day,
      endsOn: day.nullable(),
    }),
  ),
  teams: z.array(
    z.object({ id: z.uuid(), name: z.string(), primary: z.boolean(), since: z.string() }),
  ),
});
export type Employee = z.infer<typeof employeeSchema>;

const identityFields = {
  dateOfBirth: day.nullable(),
  documentKind: z.enum(['cccd', 'cmnd', 'passport']).nullable(),
  documentNumber: z.string().nullable(),
  taxCode: z.string().nullable(),
  gender,
  phone: z.string().nullable(),
  workEmail: z.string().nullable(),
};
const identitySchema = z.object({ employeeId: z.uuid(), version, ...identityFields });
export type EmployeeIdentity = z.infer<typeof identitySchema>;

export type IdentityInput = Omit<EmployeeIdentity, 'employeeId' | 'version'>;

const ratesSchema = z.object({
  items: z
    .array(z.object({ id: z.uuid(), effectiveFrom: day, annualMinutes: z.number().int() }))
    .max(100),
});
export type LeaveRate = z.infer<typeof ratesSchema>['items'][number];

const accountsSchema = z.object({
  items: z
    .array(
      z.object({
        userId: z.uuid(),
        email: z.string().nullable(),
        state: z.string(),
        enrollment: z.string().nullable(),
      }),
    )
    .max(100),
  total: z.string(),
});
export type AccountOption = z.infer<typeof accountsSchema>['items'][number];

const createdSchema = z.object({ id: z.uuid() });

/** ADR-19: own hours of one employee, the frames that end today or later. */
const framesSchema = z.object({
  today: z.iso.date(),
  maxMinutes: z.number().int().min(60).max(720),
  frames: z
    .array(
      z.object({
        id: z.uuid(),
        validFrom: z.iso.date(),
        validTo: z.iso.date().nullable(),
        days: weekSchema,
      }),
    )
    .max(1000),
});
export type ScheduleFrames = z.infer<typeof framesSchema>;

/** The hours each day of a range gets, as requests see them. */
const daysSchema = z.object({
  employeeId: z.uuid(),
  days: z
    .array(
      z.object({
        date: z.iso.date(),
        kind: z.enum(['workday', 'off', 'paid_holiday', 'makeup_workday']),
        shifts: frameSchema,
      }),
    )
    .max(92),
});
export type ScheduleDays = z.infer<typeof daysSchema>;
const versionSchema = z.object({ version });

export interface EmployeeCreate {
  readonly code: string;
  readonly fullName: string;
  readonly hiredOn: string;
  readonly status: 'probation' | 'official';
  /** Only for `official` (default 12 days on the API); the API refuses it for `probation`. */
  readonly annualLeaveMinutes?: number;
  readonly identity: IdentityInput;
  readonly position: string | null;
  readonly classification: Employee['classification'];
}

/** `GET /api/hr/employees/me`: the linked employee (null for Root or an unlinked account) and a display hint. */
const ownEmployeeSchema = z.object({
  employee: z
    .object({ id: z.uuid(), code: z.string().max(32), fullName: z.string().max(200) })
    .nullable(),
  /** Display hint for HR administration buttons; the API still decides every action. */
  companyScope: z.boolean(),
});
export type OwnEmployee = z.infer<typeof ownEmployeeSchema>;

export interface EmployeeClient {
  me(signal?: AbortSignal): Promise<OwnEmployee>;

  list(
    query: { readonly page: number; readonly search: string; readonly size?: number },
    signal?: AbortSignal,
  ): Promise<EmployeeList>;

  detail(id: string, signal?: AbortSignal): Promise<Employee>;

  create(input: EmployeeCreate): Promise<{ id: string }>;

  update(
    id: string,
    input: {
      expectedVersion: string;
      code: string;
      fullName: string;
      position: string | null;
      classification: Employee['classification'];
    },
  ): Promise<{ version: string }>;

  confirmOfficial(id: string, effectiveOn: string): Promise<{ version: string }>;

  terminate(id: string, terminatedOn: string): Promise<{ version: string }>;

  identity(id: string, signal?: AbortSignal): Promise<EmployeeIdentity>;

  updateIdentity(
    id: string,
    input: { expectedVersion: string; identity: IdentityInput },
  ): Promise<{ version: string }>;

  leaveRates(id: string, signal?: AbortSignal): Promise<readonly LeaveRate[]>;

  addLeaveRate(id: string, input: { effectiveFrom: string; annualMinutes: number }): Promise<void>;

  linkAccount(
    id: string,
    input: { expectedVersion: string; accountId: string | null },
  ): Promise<{ version: string }>;

  /** Account picker for the link (account.read; Root today). */
  accounts(signal?: AbortSignal): Promise<readonly AccountOption[]>;

  scheduleFrames(id: string, signal?: AbortSignal): Promise<ScheduleFrames>;

  addScheduleFrame(
    id: string,
    input: { validFrom: string; validTo: string | null; days: readonly Frame[] },
  ): Promise<void>;

  /** Removes a frame not started yet, or ends the one in force today. */
  endScheduleFrame(id: string, frameId: string): Promise<void>;

  /** `from..to` inclusive, at most 92 days. */
  scheduleDays(id: string, from: string, to: string, signal?: AbortSignal): Promise<ScheduleDays>;
}

export const EMPLOYEE_PAGE_SIZE = 20;

const path = (id: string, suffix = '') => `/api/hr/employees/${encodeURIComponent(id)}${suffix}`;

export function createEmployeeClient(http: HttpClient): EmployeeClient {
  const get = <T>(url: string, schema: z.ZodType<T>, signal?: AbortSignal) =>
    http.request(url, schema, signal ? { signal } : {});

  return {
    me: (signal) => get('/api/hr/employees/me', ownEmployeeSchema, signal),
    list: ({ page, search, size = EMPLOYEE_PAGE_SIZE }, signal) => {
      const params = new URLSearchParams({
        limit: String(size),
        offset: String((page - 1) * size),
      });
      if (search) params.set('search', search);
      return get(`/api/hr/employees?${params.toString()}`, listSchema, signal);
    },
    detail: (id, signal) => get(path(id), employeeSchema, signal),
    create: (input) =>
      http.request('/api/hr/employees', createdSchema, { method: 'POST', body: input }),
    update: (id, input) => http.request(path(id), versionSchema, { method: 'PATCH', body: input }),
    confirmOfficial: (id, effectiveOn) =>
      http.request(path(id, '/official'), versionSchema, {
        method: 'POST',
        body: { effectiveOn },
      }),
    terminate: (id, terminatedOn) =>
      http.request(path(id, '/termination'), versionSchema, {
        method: 'POST',
        body: { terminatedOn },
      }),
    identity: (id, signal) => get(path(id, '/identity'), identitySchema, signal),
    updateIdentity: (id, input) =>
      http.request(path(id, '/identity'), versionSchema, { method: 'PUT', body: input }),
    leaveRates: async (id, signal) =>
      (await get(path(id, '/leave-rates'), ratesSchema, signal)).items,
    addLeaveRate: async (id, input) => {
      await http.request(path(id, '/leave-rates'), createdSchema, { method: 'POST', body: input });
    },
    linkAccount: (id, input) =>
      http.request(path(id, '/account'), versionSchema, { method: 'PUT', body: input }),
    accounts: async (signal) =>
      (await get('/api/administration/accounts?limit=100', accountsSchema, signal)).items,
    scheduleFrames: (id, signal) => get(path(id, '/schedule-frames'), framesSchema, signal),
    addScheduleFrame: async (id, input) => {
      await http.request(path(id, '/schedule-frames'), createdSchema, {
        method: 'POST',
        body: input,
      });
    },
    endScheduleFrame: async (id, frameId) => {
      await http.request(
        path(id, `/schedule-frames/${encodeURIComponent(frameId)}`),
        createdSchema,
        { method: 'DELETE' },
      );
    },
    scheduleDays: (id, from, to, signal) =>
      get(
        path(id, `/schedule?${new URLSearchParams({ from, to }).toString()}`),
        daysSchema,
        signal,
      ),
  };
}
