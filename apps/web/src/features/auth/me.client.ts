import { z } from 'zod';
import type { HttpClient } from '../../infrastructure/http.client';

/** Menu keys the server may grant (design §10.2); display only, every action is checked by the API. */
const menuSchema = z.enum([
  'requests',
  'approvals',
  'employees',
  'teams',
  'calendar',
  'leave',
  'attendance',
  'reports',
  'accounts',
  'settings',
  'roles',
]);
export type NavigationMenu = z.infer<typeof menuSchema>;

/** `GET /api/auth/me` (design §10.2): account and server-granted menus. Unknown keys are a broken contract. */
const meSchema = z.object({
  userId: z.uuid(),
  menus: z.array(menuSchema).max(11),
});
export type AuthMe = z.infer<typeof meSchema>;

export interface MeClient {
  me(signal?: AbortSignal): Promise<AuthMe>;
}

export function createMeClient(http: HttpClient): MeClient {
  return {
    me: (signal) => http.request('/api/auth/me', meSchema, signal ? { signal } : {}),
  };
}
