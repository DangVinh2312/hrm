import { z } from 'zod';
import type { HttpClient } from '../../infrastructure/http.client';

/** One page of accounts; the API bounds `limit` (ADR 0020) and orders by email. */
export const ACCOUNT_PAGE_SIZE = 20;

const accountSchema = z.object({
  userId: z.uuid(),
  email: z.string().nullable(),
  state: z.enum(['active', 'pending', 'suspended']),
  // 'pending' while the first-login invitation is live, 'expired' after it lapsed (ADR 0020).
  enrollment: z.enum(['pending', 'expired']).nullable(),
});
export type AccountRow = z.infer<typeof accountSchema>;

const listSchema = z.object({ items: z.array(accountSchema).max(100), total: z.string() });
export type AccountPage = z.infer<typeof listSchema>;

const provisionedSchema = z.object({
  userId: z.uuid(),
  email: z.string().nullable(),
  state: z.string(),
});
const statusSchema = z.object({ status: z.string() });

/** A rule exactly as the API stores it (ADR 0046); the page only displays it. */
const grantSchema = z.object({
  permission: z.string().min(3).max(160),
  effect: z.enum(['allow', 'deny']),
  template: z.string().min(1).max(128),
  version: z.number().int().positive(),
  parameters: z.record(z.string(), z.union([z.string(), z.boolean()])),
});
export type RoleGrant = z.infer<typeof grantSchema>;

const roleSourceSchema = z.enum(['code', 'runtime']);
const roleSchema = z.object({
  key: z.string().min(1).max(96),
  label: z.string().max(120),
  source: roleSourceSchema,
  holders: z.number().int().nonnegative(),
  grants: z.array(grantSchema).max(500),
});
// `truncated`: a read limit cut the answer (ADR 0047 §6); the page says so instead of implying it is complete.
const roleMatrixSchema = z.object({
  roles: z.array(roleSchema).max(200),
  truncated: z.boolean(),
});
export type RoleMatrix = z.infer<typeof roleMatrixSchema>;

export type RoleRow = z.infer<typeof roleSchema>;

const accountPermissionsSchema = z.object({
  roles: z
    .array(
      z.object({
        key: z.string().min(1).max(96),
        label: z.string().max(120),
        source: roleSourceSchema,
      }),
    )
    .max(200),
  // `user`: a rule attached straight to the account (no screen creates one).
  grants: z.array(grantSchema.extend({ source: z.enum(['role', 'user']) })).max(5000),
  truncated: z.boolean(),
});
export type AccountPermissions = z.infer<typeof accountPermissionsSchema>;

export interface AdministrationClient {
  list(page: { readonly page: number }, signal?: AbortSignal): Promise<AccountPage>;

  /** `account.provision`: a pending account that signs in with the Google account of this email. */
  provision(email: string): Promise<z.infer<typeof provisionedSchema>>;

  /** `account.suspend`: the account and all its sessions end. */
  suspend(userId: string): Promise<void>;

  /** `account.reactivate`: back to `active` (Google bound) or `pending`; earlier sessions stay ended. */
  reactivate(userId: string): Promise<void>;

  /** `role.read` (ADR 0046): every role with its rules. 404 when the caller may not read it. */
  roles(signal?: AbortSignal): Promise<RoleMatrix>;

  /** `account.readPermissions`: the roles and rules of one IAM account. 404 when not reachable. */
  accountPermissions(userId: string, signal?: AbortSignal): Promise<AccountPermissions>;
}

const userPath = (id: string, action: string) =>
  `/api/administration/users/${encodeURIComponent(id)}/${action}`;

export function createAdministrationClient(http: HttpClient): AdministrationClient {
  return {
    list: ({ page }, signal) =>
      http.request(
        `/api/administration/accounts?limit=${ACCOUNT_PAGE_SIZE}&offset=${(page - 1) * ACCOUNT_PAGE_SIZE}`,
        listSchema,
        signal ? { signal } : {},
      ),
    provision: (email) =>
      http.request('/api/administration/accounts', provisionedSchema, {
        method: 'POST',
        body: { email },
      }),
    suspend: async (userId) => {
      await http.request(userPath(userId, 'suspend'), statusSchema, { method: 'POST' });
    },
    reactivate: async (userId) => {
      await http.request(userPath(userId, 'reactivate'), statusSchema, { method: 'POST' });
    },
    roles: (signal) =>
      http.request('/api/administration/roles', roleMatrixSchema, signal ? { signal } : {}),
    accountPermissions: (userId, signal) =>
      http.request(
        `/api/administration/accounts/${encodeURIComponent(userId)}/permissions`,
        accountPermissionsSchema,
        signal ? { signal } : {},
      ),
  };
}
