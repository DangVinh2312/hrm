import { z } from 'zod';
import { requestKinds, isLeave, leaveSlots } from './work-request.helper';
import type { SubmitInput } from './work-request.client';

export const MAX_REQUEST_DAYS = 31;

export interface RequestFormValues {
  kind: SubmitInput['kind'];
  /** Late arrival / early departure. */
  date: string;
  /** `HH:MM` of the same. */
  time: string;
  reason: string;
  /** WFH (date only) and leave (date + slot value `start-end`). */
  rows: { date: string; slot: string }[];
}

const validDate = (value: string) => z.iso.date().safeParse(value).success;

/**
 * Client-side hints only (required fields, shape, duplicates); the API decides every rule of the
 * request (calendar, probation, bounds, overlap). Messages are locale keys.
 */
export const requestFormSchema = z
  .object({
    kind: z.enum(requestKinds as [SubmitInput['kind'], ...SubmitInput['kind'][]]),
    date: z.string(),
    time: z.string(),
    reason: z
      .string()
      .trim()
      .min(1, 'request.form.reasonRequired')
      .max(1000, 'request.form.reasonTooLong')
      // The API refuses control characters (newline, tab, DEL) in a reason.
      // eslint-disable-next-line no-control-regex
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'error.invalidRequest'),
    rows: z.array(z.object({ date: z.string(), slot: z.string() })).max(MAX_REQUEST_DAYS),
  })
  .superRefine((values, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });

    if (values.kind === 'late-arrival' || values.kind === 'early-departure') {
      if (!validDate(values.date)) issue(['date'], 'request.form.dateInvalid');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.time))
        issue(['time'], 'request.form.timeInvalid');
      return;
    }
    if (values.rows.length === 0) issue(['rows'], 'request.form.dateInvalid');
    const seen = new Set<string>();
    values.rows.forEach((row, index) => {
      if (!validDate(row.date)) issue(['rows', index, 'date'], 'request.form.dateInvalid');
      else if (seen.has(row.date)) issue(['rows', index, 'date'], 'request.form.dateDuplicate');
      seen.add(row.date);
      if (isLeave(values.kind) && !leaveSlots.some((slot) => slot.value === row.slot))
        issue(['rows', index, 'slot'], 'request.form.slotRequired');
    });
  });

/** API body of valid form values (run `requestFormSchema` first). */
export function toSubmitInput(values: RequestFormValues): SubmitInput {
  const reason = values.reason.trim();
  const { kind } = values;
  if (kind === 'late-arrival' || kind === 'early-departure') {
    const [hours = 0, minutes = 0] = values.time.split(':').map(Number);
    return { kind, date: values.date, expectedMinute: hours * 60 + minutes, reason };
  }
  if (kind === 'wfh') return { kind, dates: values.rows.map((row) => row.date), reason };
  return {
    kind,
    reason,
    segments: values.rows.map((row) => {
      const slot = leaveSlots.find((item) => item.value === row.slot);
      return { date: row.date, startMinute: slot?.start ?? 0, endMinute: slot?.end ?? 0 };
    }),
  };
}
