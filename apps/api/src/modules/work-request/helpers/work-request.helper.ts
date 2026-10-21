/**
 * Pure submit rules (design §3, §6.4, §9; D05, D06): the segments a request books, overlap with
 * booked requests and the initial state. No clock, no host timezone: "today" and the calendar
 * come in as facts read in the submit transaction.
 */
import {
  type WorkCalendarSnapshot,
  WorkingTimeRejected,
  dayKind,
  leaveSlotMinutes,
} from '../../work-calendar/working-time.helper.js';
import type {
  ApprovalChain,
  RequestEvent,
  RequestKind,
  RequestSegment,
  RequestState,
  SubmitRequestInput,
} from '../work-request.types.js';

export type WorkRequestRejection =
  | 'crosses_year'
  | 'date_out_of_range'
  | 'not_employed'
  | 'kind_not_allowed_in_probation'
  | 'invalid_time'
  | 'invalid_slot'
  | 'non_working_day'
  | 'makeup_day';

export class WorkRequestRejected extends Error {
  constructor(readonly reason: WorkRequestRejection) {
    super(`Work request rejected: ${reason}`);
  }
}

export interface SubmitFacts {
  /** Business dates today − 7 and today + 90 (D06), inclusive. */
  readonly earliest: string;
  readonly latest: string;
  readonly calendar: WorkCalendarSnapshot;

  /** Employment status on a date; `undefined` outside employment (before hire, after leaving). */
  readonly statusOn: (date: string) => 'probation' | 'official' | undefined;
}

/** §4.5: on probation only late/early arrival and unpaid leave. */
const probationKinds: ReadonlySet<RequestKind> = new Set([
  'late-arrival',
  'early-departure',
  'unpaid-leave',
]);

const isWorkday = (date: string, calendar: WorkCalendarSnapshot) => {
  const kind = dayKind(date, calendar);
  return kind === 'workday' || kind === 'makeup_workday';
};

/**
 * Late arrival counts from the start of the shift the person arrives in, early departure up to
 * the end of the shift they leave (design §9, boundaries [P]): late 541..780 → [540, m),
 * 841..1079 → [840, m); early 541..779 → [m, 780), 841..1079 → [m, 1080). So a morning leave
 * plus a late afternoon arrival do not overlap.
 */
function timeSegment(
  kind: 'late-arrival' | 'early-departure',
  date: string,
  expected: number,
): RequestSegment {
  const [start, end] =
    kind === 'late-arrival'
      ? expected >= 541 && expected <= 780
        ? [540, expected]
        : expected >= 841 && expected <= 1079
          ? [840, expected]
          : [0, 0]
      : expected >= 541 && expected <= 779
        ? [expected, 780]
        : expected >= 841 && expected <= 1079
          ? [expected, 1080]
          : [0, 0];
  if (start === end) throw new WorkRequestRejected('invalid_time');
  return { date, startMinute: start, endMinute: end, minutes: end - start };
}

/** The business dates a validated request books, in order. */
export const requestDates = (input: SubmitRequestInput): readonly string[] =>
  'dates' in input
    ? input.dates
    : 'segments' in input
      ? input.segments.map((s) => s.date)
      : [input.date];

/**
 * Segments of a validated request, one per date, or the first rule it breaks: never across a
 * calendar year (D06; the validator sorts the dates), then for every date D06 bounds, employment
 * and probation on that very day (§4.5, not today's status), then the calendar. Leave uses the
 * T4 slot rule (also refusing makeup days, ADR 0018); WFH and late/early need a workday or a
 * makeup day.
 */
export function requestSegments(input: SubmitRequestInput, facts: SubmitFacts): RequestSegment[] {
  const dates = requestDates(input);
  if (dates[0]?.slice(0, 4) !== dates[dates.length - 1]?.slice(0, 4))
    throw new WorkRequestRejected('crosses_year');
  for (const date of dates) {
    if (date < facts.earliest || date > facts.latest)
      throw new WorkRequestRejected('date_out_of_range');
    const status = facts.statusOn(date);
    if (!status) throw new WorkRequestRejected('not_employed');
    if (status === 'probation' && !probationKinds.has(input.kind))
      throw new WorkRequestRejected('kind_not_allowed_in_probation');
  }
  if ('segments' in input)
    return input.segments.map((s) => {
      try {
        return {
          ...s,
          minutes: leaveSlotMinutes({
            date: s.date,
            start: s.startMinute,
            end: s.endMinute,
            calendar: facts.calendar,
          }),
        };
      } catch (error) {
        const reason = error instanceof WorkingTimeRejected ? error.reason : undefined;
        if (reason === 'invalid_slot' || reason === 'non_working_day' || reason === 'makeup_day')
          throw new WorkRequestRejected(reason);
        throw error;
      }
    });
  if (dates.some((date) => !isWorkday(date, facts.calendar)))
    throw new WorkRequestRejected('non_working_day');
  if ('dates' in input)
    return input.dates.map((date) => ({ date, startMinute: 540, endMinute: 1080, minutes: 480 }));
  return [timeSegment(input.kind, input.date, input.expectedMinute)];
}

/** A segment of a pending or approved request of the same employee. */
export interface BookedSegment {
  readonly kind: RequestKind;
  readonly date: string;
  readonly startMinute: number;
  readonly endMinute: number;
}

const timeOnly = (kind: RequestKind) => kind === 'late-arrival' || kind === 'early-departure';

/**
 * D06: no crossing times with pending/approved requests, except late/early on a WFH day (either
 * order). D05: at most one late arrival and one early departure per day, even apart in time.
 */
export function conflicts(
  kind: RequestKind,
  segments: readonly RequestSegment[],
  booked: readonly BookedSegment[],
): boolean {
  return booked.some((b) =>
    segments.some(
      (s) =>
        s.date === b.date &&
        !((timeOnly(kind) && b.kind === 'wfh') || (kind === 'wfh' && timeOnly(b.kind))) &&
        ((timeOnly(kind) && b.kind === kind) ||
          (s.startMinute < b.endMinute && b.startMinute < s.endMinute)),
    ),
  );
}

/**
 * §6.4 in order: a COO's request is approved at submit (the final-approval effects run in the
 * submit transaction, with a system decision `coo_self_approved`); the current lead of the chosen
 * team skips the lead step with a system decision; everyone else waits for the lead.
 */
export function initialState(facts: {
  readonly submitterIsCoo: boolean;
  readonly submitterLeadsTeam: boolean;
}):
  | { readonly state: 'approved'; readonly systemDecision: 'coo_self_approved' }
  | { readonly state: 'pending_lead'; readonly systemDecision: null }
  | {
      readonly state: 'pending_final';
      readonly systemDecision: 'lead_skipped_submitter_is_lead';
    } {
  if (facts.submitterIsCoo) return { state: 'approved', systemDecision: 'coo_self_approved' };
  return facts.submitterLeadsTeam
    ? { state: 'pending_final', systemDecision: 'lead_skipped_submitter_is_lead' }
    : { state: 'pending_lead', systemDecision: null };
}

/** §6.4.1 [C, user 2026-10-20]: late/early only need the Team Lead; the other kinds go on to the COO. */
export const approvalChain = (kind: RequestKind): ApprovalChain =>
  timeOnly(kind) ? 'lead' : 'lead-final';

/**
 * Design §6.2: the state an event leads to, or `invalid_transition` for any other pair. A
 * one-step chain makes the lead's approval the final one; `pending_final` is still reachable for
 * it when the lead step was skipped at submit (§6.4 (2)). Guards beyond the state (version, actor,
 * effect handlers) are the command's.
 */
export function nextState(
  state: RequestState,
  event: RequestEvent,
  chain: ApprovalChain,
): RequestState | 'invalid_transition' {
  switch (event) {
    case 'lead_approve':
      if (state !== 'pending_lead') return 'invalid_transition';
      return chain === 'lead' ? 'approved' : 'pending_final';
    case 'lead_reject':
      return state === 'pending_lead' ? 'rejected' : 'invalid_transition';
    case 'final_approve':
      return state === 'pending_final' ? 'approved' : 'invalid_transition';
    case 'final_reject':
      return state === 'pending_final' ? 'rejected' : 'invalid_transition';
    case 'cancel':
      return state === 'pending_lead' || state === 'pending_final'
        ? 'cancelled'
        : 'invalid_transition';
    case 'cancel_approved':
      return state === 'approved' ? 'cancelled' : 'invalid_transition';
  }
}
