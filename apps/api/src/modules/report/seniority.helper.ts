/**
 * Length of service from the employment history (design §6.3 report, acceptance R-03): from the
 * hire date to the cutoff, **both days counted** (the hire day is worked, like the attendance
 * sheet counts the first and last day) [P]. Whole months are added to the hire date with the day
 * clamped to the month's end, so 2024-01-31 + 1 month is 2024-02-29. Pure, UTC dates only, no
 * clock and no timezone.
 */
export interface Seniority {
  readonly years: number;
  readonly months: number;
  readonly days: number;
  readonly totalDays: number;
}

const DAY_MS = 86_400_000;

const parts = (date: string) => ({
  year: Number(date.slice(0, 4)),
  month: Number(date.slice(5, 7)),
  day: Number(date.slice(8, 10)),
});

const utc = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day);

/** `start` plus `count` months, the day clamped to the last day of the target month (UTC ms). */
function addMonths(start: string, count: number): number {
  const { year, month, day } = parts(start);
  const index = year * 12 + (month - 1) + count;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  const last = new Date(utc(targetYear, targetMonth + 1, 0)).getUTCDate();
  return utc(targetYear, targetMonth, Math.min(day, last));
}

/** `null` when `asOn` is before `hiredOn` (not employed yet). Dates are valid `YYYY-MM-DD`. */
export function seniorityOf(hiredOn: string, asOn: string): Seniority | null {
  if (asOn < hiredOn) return null;
  const hired = parts(hiredOn);
  const end = parts(asOn);
  // Exclusive end: the cutoff day itself counts.
  const exclusive = utc(end.year, end.month, end.day) + DAY_MS;
  const totalDays = Math.round((exclusive - utc(hired.year, hired.month, hired.day)) / DAY_MS);
  let months = (end.year - hired.year) * 12 + (end.month - hired.month) + 1;
  while (months > 0 && addMonths(hiredOn, months) > exclusive) months--;
  return {
    years: Math.floor(months / 12),
    months: months % 12,
    days: Math.round((exclusive - addMonths(hiredOn, months)) / DAY_MS),
    totalDays,
  };
}
