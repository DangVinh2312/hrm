import { z } from 'zod';
import type { HttpClient } from '../infrastructure/http.client';

const version = z.string().regex(/^[1-9][0-9]{0,17}$/);
const person = z.object({ employeeId: z.uuid(), code: z.string(), fullName: z.string() });
export type TeamPerson = z.infer<typeof person>;

const listSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        lead: person.nullable(),
        memberCount: z.number().int().nonnegative(),
      }),
    )
    .max(100),
  total: z.string(),
});
export type TeamList = z.infer<typeof listSchema>;

const teamSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  version,
  lead: person.nullable(),
  members: z.array(person.extend({ primary: z.boolean(), since: z.string() })).max(500),
  leadHistory: z
    .array(person.extend({ startsAt: z.string(), endsAt: z.string().nullable() }))
    .max(50),
});
export type Team = z.infer<typeof teamSchema>;

const createdSchema = z.object({ id: z.uuid() });
const versionSchema = z.object({ version });
const statusSchema = z.object({ status: z.string() });

export interface TeamClient {
  list(signal?: AbortSignal): Promise<TeamList>;

  detail(id: string, signal?: AbortSignal): Promise<Team>;

  create(name: string): Promise<{ id: string }>;

  rename(id: string, input: { expectedVersion: string; name: string }): Promise<void>;

  addMember(id: string, input: { employeeId: string; primary: boolean }): Promise<void>;

  setPrimary(id: string, employeeId: string): Promise<void>;

  endMembership(id: string, employeeId: string): Promise<void>;

  assignLead(id: string, employeeId: string | null): Promise<void>;
}

const path = (id: string, suffix = '') => `/api/hr/teams/${encodeURIComponent(id)}${suffix}`;

/** shortcut: one page of 100 teams; enough for ~50 staff, page it when the list can grow past it. */
export function createTeamClient(http: HttpClient): TeamClient {
  return {
    list: (signal) => http.request('/api/hr/teams?limit=100', listSchema, signal ? { signal } : {}),
    detail: (id, signal) => http.request(path(id), teamSchema, signal ? { signal } : {}),
    create: (name) =>
      http.request('/api/hr/teams', createdSchema, { method: 'POST', body: { name } }),
    rename: async (id, input) => {
      await http.request(path(id), versionSchema, { method: 'PATCH', body: input });
    },
    addMember: async (id, input) => {
      await http.request(path(id, '/members'), statusSchema, { method: 'POST', body: input });
    },
    setPrimary: async (id, employeeId) => {
      await http.request(
        path(id, `/members/${encodeURIComponent(employeeId)}/primary`),
        statusSchema,
        { method: 'POST' },
      );
    },
    endMembership: async (id, employeeId) => {
      await http.request(path(id, `/members/${encodeURIComponent(employeeId)}`), statusSchema, {
        method: 'DELETE',
      });
    },
    assignLead: async (id, employeeId) => {
      await http.request(path(id, '/lead'), statusSchema, { method: 'PUT', body: { employeeId } });
    },
  };
}
