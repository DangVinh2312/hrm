import { ProductAccessDenied } from '../../authorization/services/product-authority.service.js';

/**
 * Display-only reads (menus, design §10.2): a read the caller holds no grant for counts as
 * "nothing visible". Never used for an operation: there a denial stays a denial (403).
 */
export async function visibleOrNothing<T>(read: Promise<T>, nothing: T): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof ProductAccessDenied) return nothing;
    throw error;
  }
}
