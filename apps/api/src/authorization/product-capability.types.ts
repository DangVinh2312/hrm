/**
 * Capability names a product release declares (`capabilities.validators`/`obligationHandlers`) and
 * policies reference. The value carries its own version (`fresh@1`), so changing semantics means a
 * new name, never an edit of this one. Plain `as const` objects, not TypeScript `enum`s: see
 * apps/api/AGENTS.md ("Khai báo quyền bằng hằng có kiểu").
 */
export const ProductValidator = {
  /** Reauthentication from the last 300 s (ADR 0022). */
  Fresh: 'fresh@1',
} as const;

export type ProductValidator = (typeof ProductValidator)[keyof typeof ProductValidator];

export const ProductObligation = {
  /** Appends the access event to the audit log inside the decision transaction. */
  Audit: 'audit@1',
} as const;

export type ProductObligation = (typeof ProductObligation)[keyof typeof ProductObligation];
