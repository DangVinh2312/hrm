import { z } from 'zod';
import type { HttpClient } from '../../infrastructure/http.client';
import type { NavigationMenu } from '../../app/navigation.config';

const menuSchema = z.enum([
  'requests',
  'approvals',
  'employees',
  'teams',
  'calendar',
  'leave',
  'attendance',
  'reports',
]) satisfies z.ZodType<NavigationMenu>;

/** `GET /api/hr/me` (design §10.2). Unknown menu keys are a broken contract, never shown. */
const meSchema = z.object({
  userId: z.uuid(),
  employee: z
    .object({ id: z.uuid(), code: z.string().max(32), fullName: z.string().max(200) })
    .nullable(),
  menus: z.array(menuSchema).max(8),
  /** Display hint for HR administration buttons; the API still decides every action. */
  companyScope: z.boolean(),
});
export type HrMe = z.infer<typeof meSchema>;

export interface HrClient {
  me(signal?: AbortSignal): Promise<HrMe>;
}

export function createHrClient(http: HttpClient): HrClient {
  return {
    me: (signal) => http.request('/api/hr/me', meSchema, signal ? { signal } : {}),
  };
}
