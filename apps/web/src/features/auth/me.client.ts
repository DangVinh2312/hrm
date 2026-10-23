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

/** `GET /api/auth/me` (design §10.2): account and server-granted menus. Unknown keys are a broken contract. */
const accountMeSchema = z.object({
  userId: z.uuid(),
  menus: z.array(menuSchema).max(8),
});

/** `GET /api/hr/employees/me`: the linked employee (null for Root or an unlinked account) and a display hint. */
const employeeMeSchema = z.object({
  employee: z
    .object({ id: z.uuid(), code: z.string().max(32), fullName: z.string().max(200) })
    .nullable(),
  /** Display hint for HR administration buttons; the API still decides every action. */
  companyScope: z.boolean(),
});

export type HrMe = z.infer<typeof accountMeSchema> & z.infer<typeof employeeMeSchema>;

export interface HrClient {
  me(signal?: AbortSignal): Promise<HrMe>;
}

export function createHrClient(http: HttpClient): HrClient {
  return {
    // Accounts and employees are separate entities (ADR 0037): two endpoints, one merged view.
    async me(signal) {
      const options = signal ? { signal } : {};
      const [account, profile] = await Promise.all([
        http.request('/api/auth/me', accountMeSchema, options),
        http.request('/api/hr/employees/me', employeeMeSchema, options),
      ]);
      return { ...account, ...profile };
    },
  };
}
