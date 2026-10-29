import { ApiRejection } from './api-error.helper.js';

/**
 * A stored claim of this actor and key: its result is the answer to a retry, unless the retry
 * carries another payload (`error.idempotencyKeyReused`, 422). The key space is the actor's own
 * (the PK starts with `actor_id`), so the refusal says nothing about anyone else.
 */
export function replay<T>(prior: { readonly hash: string; readonly result: T }, hash: string): T {
  if (prior.hash !== hash) throw new ApiRejection('error.idempotencyKeyReused');
  return prior.result;
}
