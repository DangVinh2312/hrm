import { z } from 'zod';

/**
 * Shared form rules (messages are locale keys). They mirror the API validators so most mistakes
 * show next to the field; the API still validates everything.
 */
const blankToNull = (value: string | null) =>
  value === null || value.trim() === '' ? null : value.trim();

/** Same normalization and format as the API validators (ADR 0028). */
const normalizePhone = (value: string) => {
  const stripped = value.replace(/[ .\-()]/g, '');
  return stripped.startsWith('+84') ? `0${stripped.slice(3)}` : stripped;
};

const workEmailPattern =
  /^[a-z0-9_+-]+(\.[a-z0-9_+-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const nullableChoice = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.string().nullable().transform(blankToNull).pipe(z.enum(values).nullable());

/** F1 extras of the profile form (position and classification are both optional). */
export const profileSchema = z.object({
  position: z
    .string()
    .transform(blankToNull)
    .pipe(z.string().max(100, 'employee.form.tooLong').nullable()),
  classification: nullableChoice(['fullTime', 'contractor']),
});

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
    gender: nullableChoice(['male', 'female', 'other']),
    phone: z
      .string()
      .transform(blankToNull)
      .pipe(
        z
          .string()
          .refine((v) => /^0[1-9][0-9]{8,9}$/.test(normalizePhone(v)), 'employee.form.phoneInvalid')
          .transform(normalizePhone)
          .nullable(),
      ),
    workEmail: z
      .string()
      .transform(blankToNull)
      .pipe(
        z
          .string()
          .transform((v) => v.toLowerCase())
          .refine((v) => v.length <= 254 && workEmailPattern.test(v), 'employee.form.emailInvalid')
          .nullable(),
      ),
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
