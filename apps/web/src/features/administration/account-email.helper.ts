import { z } from 'zod';

/** The API stores the lower-case form; a malformed address is stopped before any request. */
export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
