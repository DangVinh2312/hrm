import type { DatedMinutes, LeaveBalanceView } from '../leave.types.js';

export interface StatusPeriod {
  readonly status: 'probation' | 'official';
  readonly startsOn: string;
  /** Exclusive. */
  readonly endsOn: string | null;
}

export interface RatePeriod {
  readonly effectiveFrom: string;
  readonly annualMinutes: number;
}

/** What the accrual of one employee and year depends on (all business dates `YYYY-MM-DD`). */
export interface AccrualFacts {
  readonly year: number;
  readonly hiredOn: string;
  /** Last working day. */
  readonly terminatedOn: string | null;
  readonly periods: readonly StatusPeriod[];
  readonly rates: readonly RatePeriod[];
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Month (1..12) of a business date of `year`; refuses another year (callers filter by year). */
function monthIn(date: string, year: number): number {
  if (Number(date.slice(0, 4)) !== year) throw new Error('Date is outside the leave year');
  return Number(date.slice(5, 7));
}

/**
 * Cumulative accrual at the end of each month 1..12 (index 0..11), design §9 / D03. Month M
 * counts when, on its 15th, the employee is employed and `official`; probation never accrues and
 * is never paid back. With k counted months so far and R the rate in force on that 15th, the
 * month adds `floor(R*k/12) - floor(R*(k-1)/12)`, so a constant rate gives exactly R after twelve
 * counted months. No rate on a counted 15th accrues nothing (a rate row is written with the
 * official period, so this is unreachable for real data; guessing a standard rate would
 * grant leave unrecorded).
 * No carry-over from other years and no seniority bonus (D03). Integers only.
 */
export function accruedByMonth(facts: AccrualFacts): readonly number[] {
  const rates = [...facts.rates].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const cumulative: number[] = [];
  let counted = 0;
  let total = 0;
  for (let month = 1; month <= 12; month++) {
    const day = `${facts.year}-${pad(month)}-15`;
    const employed =
      facts.hiredOn <= day && (facts.terminatedOn === null || facts.terminatedOn >= day);
    const official = facts.periods.some(
      (p) => p.status === 'official' && p.startsOn <= day && (p.endsOn === null || p.endsOn > day),
    );
    const rate = rates.filter((r) => r.effectiveFrom <= day).at(-1);
    if (employed && official && rate) {
      counted += 1;
      total +=
        Math.floor((rate.annualMinutes * counted) / 12) -
        Math.floor((rate.annualMinutes * (counted - 1)) / 12);
    }
    cumulative.push(total);
  }
  return cumulative;
}

/** Minutes of `entries` summed per month of `year`, index 0..11 (not cumulative). */
export function monthlyMinutes(entries: readonly DatedMinutes[], year: number): readonly number[] {
  const months = Array.from({ length: 12 }, () => 0);
  for (const entry of entries) {
    const index = monthIn(entry.date, year) - 1;
    months[index] = (months[index] ?? 0) + entry.minutes;
  }
  return months;
}

const cumulative = (months: readonly number[]) => {
  let sum = 0;
  return months.map((minutes) => (sum += minutes));
};

/**
 * Spec §8: for every month M, committed minutes (approved + pending) with a date up to the end of
 * M must not exceed what was accrued to the end of M. The first month (1..12) that breaks it, or
 * `undefined`. `accrued` is cumulative, `committed` per month. A negative entitlement (an
 * adjustment taking leave back) only forbids taking leave: with nothing committed up to a month
 * the invariant holds there, so earlier empty months never block a later request.
 */
export function firstMonthOver(
  accrued: readonly number[],
  committed: readonly number[],
): number | undefined {
  const used = cumulative(committed);
  const index = used.findIndex((minutes, i) => minutes > Math.max(0, accrued[i] ?? 0));
  return index < 0 ? undefined : index + 1;
}

/** Entitlement per month: accrual plus the opening/adjustment entries dated up to that month. */
export function entitledByMonth(
  accrued: readonly number[],
  adjustments: readonly DatedMinutes[],
  year: number,
): readonly number[] {
  const adjusted = cumulative(monthlyMinutes(adjustments, year));
  return accrued.map((minutes, i) => minutes + (adjusted[i] ?? 0));
}

const sum = (entries: readonly DatedMinutes[], keep: (entry: DatedMinutes) => boolean) =>
  entries.filter(keep).reduce((total, entry) => total + entry.minutes, 0);

/** The balance at `asOn` (D09); every list holds entries of the report year only. */
export function leaveBalanceView(input: {
  readonly employeeId: string;
  readonly asOn: string;
  readonly facts: AccrualFacts;
  readonly adjustments: readonly DatedMinutes[];
  readonly approved: readonly DatedMinutes[];
  readonly pending: readonly DatedMinutes[];
}): LeaveBalanceView {
  const year = Number(input.asOn.slice(0, 4));
  if (year !== input.facts.year) throw new Error('Facts are for another year');
  const month = monthIn(input.asOn, year);
  const entitled =
    entitledByMonth(accruedByMonth(input.facts), input.adjustments, year)[month - 1] ?? 0;
  const used = sum(input.approved, (e) => e.date <= input.asOn);
  const ahead = sum(input.approved, (e) => e.date > input.asOn);
  const pending = sum(input.pending, () => true);
  // Probation has no leave rate: shown only while `asOn` is in an official period, even
  // when an older row exists from before that rule.
  const official = input.facts.periods.some(
    (p) =>
      p.status === 'official' &&
      p.startsOn <= input.asOn &&
      (p.endsOn === null || p.endsOn > input.asOn),
  );
  const rate = official
    ? [...input.facts.rates]
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
        .filter((r) => r.effectiveFrom <= input.asOn)
        .at(-1)
    : undefined;
  return {
    employeeId: input.employeeId,
    year,
    asOn: input.asOn,
    annualMinutes: rate?.annualMinutes ?? null,
    entitledMinutes: entitled,
    usedMinutes: used,
    futureApprovedMinutes: ahead,
    pendingMinutes: pending,
    availableMinutes: Math.max(0, entitled - used - ahead - pending),
  };
}
