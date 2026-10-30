import { z } from 'zod';
import type { HttpClient } from '../../infrastructure/http.client';

/** One page of accounts; the API bounds `limit` and orders by email. */
export const ACCOUNT_PAGE_SIZE = 20;

const accountSchema = z.object({
  userId: z.uuid(),
  email: z.string().nullable(),
  state: z.enum(['active', 'pending', 'suspended']),
  // 'pending' while the first-login invitation is live, 'expired' after it lapsed.
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

/** A rule exactly as the API stores it; the page only displays it. */
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
// `truncated`: a read limit cut the answer; the page says so instead of implying it is complete.
const roleMatrixSchema = z.object({
  roles: z.array(roleSchema).max(200),
  truncated: z.boolean(),
});
export type RoleMatrix = z.infer<typeof roleMatrixSchema>;

export type RoleRow = z.infer<typeof roleSchema>;

const boundarySchema = z.object({
  permission: z.string().min(3).max(160),
  key: z.string().min(1).max(96),
  version: z.number().int().positive(),
  seeded: z.boolean(),
});
export type AccountBoundary = z.infer<typeof boundarySchema>;

export interface BoundaryRef {
  readonly key: string;
  readonly version: number;
}

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
  // One binding per permission; `seeded` marks the ones the release owns.
  boundaries: z.array(boundarySchema).max(200),
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

  /** `role.read`: every role with its rules. 404 when the caller may not read it. */
  roles(signal?: AbortSignal): Promise<RoleMatrix>;

  /** `account.readPermissions`: the roles and rules of one IAM account. 404 when not reachable. */
  accountPermissions(userId: string, signal?: AbortSignal): Promise<AccountPermissions>;

  /** `account.assignRole`: 404 for a role or account the caller cannot reach, 409 when held or at the cap. */
  assignRole(userId: string, roleKey: string): Promise<void>;

  /** `account.revokeRole`: 409 when the account does not hold it. */
  revokeRole(userId: string, roleKey: string): Promise<void>;

  /** `account.bindBoundary`: the whole package of one boundary version; 409 when any of it is bound. */
  bindBoundary(userId: string, ref: BoundaryRef): Promise<void>;

  /** `account.unbindBoundary`: removes the bindings the release did not seed; 409 when none. */
  unbindBoundary(userId: string, ref: BoundaryRef): Promise<void>;

  /** `role.delete` of a runtime role: 409 while an account holds it. */
  deleteRole(roleKey: string): Promise<void>;
}

const userPath = (id: string, action: string) =>
  `/api/administration/users/${encodeURIComponent(id)}/${action}`;

const accountPath = (id: string, tail: string) =>
  `/api/administration/accounts/${encodeURIComponent(id)}/${tail}`;

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
    assignRole: async (userId, roleKey) => {
      await http.request(accountPath(userId, 'roles'), statusSchema, {
        method: 'POST',
        body: { roleKey },
      });
    },
    revokeRole: async (userId, roleKey) => {
      await http.request(
        accountPath(userId, `roles/${encodeURIComponent(roleKey)}`),
        statusSchema,
        {
          method: 'DELETE',
        },
      );
    },
    bindBoundary: async (userId, ref) => {
      await http.request(accountPath(userId, 'boundaries'), statusSchema, {
        method: 'POST',
        body: { key: ref.key, version: ref.version },
      });
    },
    unbindBoundary: async (userId, ref) => {
      await http.request(
        accountPath(userId, `boundaries/${encodeURIComponent(ref.key)}/${ref.version}`),
        statusSchema,
        { method: 'DELETE' },
      );
    },
    deleteRole: async (roleKey) => {
      await http.request(`/api/administration/roles/${encodeURIComponent(roleKey)}`, statusSchema, {
        method: 'DELETE',
      });
    },
  };
}
