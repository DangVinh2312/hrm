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

export interface AdministrationClient {
  list(page: { readonly page: number }, signal?: AbortSignal): Promise<AccountPage>;

  /** `account.provision`: a pending account that signs in with the Google account of this email. */
  provision(email: string): Promise<z.infer<typeof provisionedSchema>>;

  /** `account.suspend`: the account and all its sessions end. */
  suspend(userId: string): Promise<void>;

  /** `account.reactivate`: back to `active` (Google bound) or `pending`; earlier sessions stay ended. */
  reactivate(userId: string): Promise<void>;
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
  };
}
