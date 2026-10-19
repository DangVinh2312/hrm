import { z } from 'zod';
import { ApiError, ResponseShapeError, type HttpClient } from '../infrastructure/http.client';

const sessionSchema = z.object({
  userId: z.uuid(),
  method: z.string().min(1).max(64),
  assurance: z.string().min(1).max(64),
});
export type SessionView = z.infer<typeof sessionSchema>;

const redirectSchema = z.object({ authorizationUrl: z.string() });
const statusSchema = z.object({ status: z.string() });

/** Only an HTTPS authorization endpoint is followed; anything else is a broken contract. */
export function authorizationUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ResponseShapeError();
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new ResponseShapeError();
  return url.href;
}

export interface AuthClient {
  /** `null` when there is no valid session (401); other failures propagate. */
  session(signal?: AbortSignal): Promise<SessionView | null>;

  beginLogin(): Promise<string>;

  beginActivation(token: string): Promise<string>;

  logout(): Promise<void>;
}

export function createAuthClient(http: HttpClient, issuer: string): AuthClient {
  return {
    async session(signal) {
      try {
        return await http.request('/api/auth/session', sessionSchema, signal ? { signal } : {});
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    async beginLogin() {
      const result = await http.request('/api/auth/oidc/begin', redirectSchema, {
        method: 'POST',
        body: { issuer },
      });
      return authorizationUrl(result.authorizationUrl);
    },
    async beginActivation(token) {
      const result = await http.request('/api/auth/oidc/activate', redirectSchema, {
        method: 'POST',
        body: { issuer, token },
      });
      return authorizationUrl(result.authorizationUrl);
    },
    async logout() {
      try {
        await http.request('/api/auth/logout', statusSchema, { method: 'POST' });
      } catch (error) {
        // Already signed out on the server: the local reset still has to happen.
        if (!(error instanceof ApiError && error.status === 401)) throw error;
      } finally {
        http.reset();
      }
    },
  };
}
