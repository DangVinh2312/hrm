/** A boundary version as the catalog stores it and a request names it. */
export interface BoundaryRef {
  readonly key: string;
  readonly version: number;
}

/** Most permissions one bound package may hold: a larger catalog entry is refused, never written in part. */
export const MAX_BOUNDARY_PACKAGE = 64;

const MAX_BOUNDARY_VERSION = 2_147_483_647;

const boundaryKey = /^[A-Za-z][A-Za-z0-9._-]{0,95}$/;

export const isBoundaryKey = (value: unknown): value is string =>
  typeof value === 'string' && boundaryKey.test(value);

/** The `integer` column and the audit detail share this range. */
export const isBoundaryVersion = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= MAX_BOUNDARY_VERSION;

export function isBoundaryRef(value: unknown): value is BoundaryRef {
  if (typeof value !== 'object' || value === null) return false;
  const { key, version } = value as Record<string, unknown>;
  return isBoundaryKey(key) && isBoundaryVersion(version);
}
