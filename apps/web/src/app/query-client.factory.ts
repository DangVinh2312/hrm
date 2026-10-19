import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError, ResponseShapeError } from '../infrastructure/http.client';

/** Statuses that a retry cannot fix: auth, validation, permission, absence, throttling. */
const FINAL_STATUSES = new Set([400, 401, 403, 404, 409, 422, 429]);
const MAX_QUERY_RETRIES = 2;

/**
 * One client per app instance (never module-global). A 401 from any query or mutation means the
 * session ended; `onUnauthorized` lets the session owner clear protected cache and drafts.
 */
export function createQueryClient(onUnauthorized: () => void): QueryClient {
  const unauthorized = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) onUnauthorized();
  };

  return new QueryClient({
    queryCache: new QueryCache({ onError: unauthorized }),
    mutationCache: new MutationCache({ onError: unauthorized }),
    defaultOptions: {
      queries: {
        retry: (failures, error) =>
          failures < MAX_QUERY_RETRIES &&
          !(error instanceof ApiError && FINAL_STATUSES.has(error.status)) &&
          // A body that breaks the contract is the same on every attempt.
          !(error instanceof ResponseShapeError),
      },
      // Submit/approve/sign are never retried automatically; see engineering conventions §3.
      mutations: { retry: false },
    },
  });
}
