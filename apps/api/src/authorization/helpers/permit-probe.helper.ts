/**
 * Upper bound of `ProductAuthorization.permitsMany` (menus): input comes from composition code,
 * still bounded. 17 = the menu lookup of an account with a linked profile (ADR 0046): 11 pairs of
 * the HR menus (any-of groups counted flat), `account.read`, `setting.read`, `role.read` and the
 * three self-service pairs. Raised from 16 only after measuring the cost per pair (ADR 0046 §5).
 */
export const MAX_PERMIT_PROBES = 17;

export interface PermitProbe {
  readonly resource: string;
  readonly action: string;
}

/** One pair, or an any-of group of pairs evaluated in order up to the first reachable one. */
export type PermitQuery = PermitProbe | readonly PermitProbe[];

export const isPermitProbe = (value: unknown): value is PermitProbe =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as PermitProbe).resource === 'string' &&
  typeof (value as PermitProbe).action === 'string';

/** Non-empty list, no empty group, at most MAX_PERMIT_PROBES pairs once groups are flattened. */
export function validPermitQueries(queries: unknown): queries is readonly PermitQuery[] {
  if (!Array.isArray(queries) || queries.length < 1) return false;
  let pairs = 0;
  for (const query of queries as unknown[]) {
    if (Array.isArray(query)) {
      if (query.length < 1 || !(query as unknown[]).every(isPermitProbe)) return false;
      pairs += query.length;
    } else if (isPermitProbe(query)) pairs++;
    else return false;
  }
  return pairs <= MAX_PERMIT_PROBES;
}
