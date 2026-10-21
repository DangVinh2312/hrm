export const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The business month now (ADR 0018: Asia/Ho_Chi_Minh). */
export const currentMonth = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date());

/** Same bound as the API and the table CHECK: one adjustment is at most one day of paid time. */
export const MAX_ADJUSTMENT_MINUTES = 1440;

/** A source reference: letters, digits and ` . _ / # : -`, at most 64 characters (API validator). */
export const referencePattern = /^[\p{L}\p{N}][\p{L}\p{N} ._/#:-]{0,63}$/u;
