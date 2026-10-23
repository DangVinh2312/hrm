import { QueryFailedError } from 'typeorm';

/** A UNIQUE constraint refused the write (duplicate code, document, link…). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError && (error.driverError as { code?: unknown }).code === '23505'
  );
}
