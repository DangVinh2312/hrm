import { z } from 'zod';

/**
 * Shared form rules (messages are locale keys). They mirror the API validators so most mistakes
 * show next to the field; the API still validates everything.
 */
const blankToNull = (value: string | null) =>
  value === null || value.trim() === '' ? null : value.trim();

export const identitySchema = z
  .object({
    dateOfBirth: z
      .string()
      .transform(blankToNull)
      .pipe(z.iso.date('employee.form.dateInvalid').nullable()),
    documentKind: z
      .string()
      .nullable()
      .transform(blankToNull)
      .pipe(z.enum(['cccd', 'cmnd', 'passport']).nullable()),
    documentNumber: z
      .string()
      .transform((value) => blankToNull(value.toUpperCase()))
      .pipe(
        z
          .string()
          .regex(/^[A-Z0-9]{6,20}$/, 'employee.form.documentNumberInvalid')
          .nullable(),
      ),
    taxCode: z
      .string()
      .transform(blankToNull)
      .pipe(
        z
          .string()
          .regex(/^[0-9]{10,13}(-[0-9]{3})?$/, 'employee.form.taxCodeInvalid')
          .nullable(),
      ),
  })
  .refine((value) => (value.documentKind === null) === (value.documentNumber === null), {
    message: 'employee.form.documentPair',
    path: ['documentNumber'],
  });

/** Annual leave in days: ≥ 12 (requirement §4.3), quarter days so minutes stay integers. */
export const leaveDaysSchema = z
  .number({ error: 'employee.form.leaveDaysInvalid' })
  .min(12, 'employee.form.leaveDaysInvalid')
  .max(366, 'employee.form.leaveDaysInvalid')
  .refine((days) => Number.isInteger(days * 4), 'employee.form.leaveDaysInvalid');

export const businessDateSchema = z.iso.date('employee.form.dateInvalid');
