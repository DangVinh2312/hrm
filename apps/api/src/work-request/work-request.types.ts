/**
 * Work request contracts (T5, design §6, ADR 0018). The submitter and the employee are always
 * the session's own profile, never payload fields; a submitted request is immutable (D06).
 */

export type RequestKind =
  'late-arrival' | 'early-departure' | 'wfh' | 'annual-leave' | 'unpaid-leave';

export type RequestState = 'pending_lead' | 'pending_final' | 'approved' | 'rejected' | 'cancelled';

interface SubmitCommon {
  /** A current team of the submitter; `null` = the current primary team (D01). */
  readonly teamId: string | null;
  /** 1..1000 code points, no control characters (design §11). */
  readonly reason: string;
}

/** One leave slot of a business date (09–11, 11–13, 14–16, 16–18, 09–13, 14–18, 09–18). */
export interface LeaveSlotInput {
  readonly date: string;
  readonly startMinute: number;
  readonly endMinute: number;
}

/** Validated body, discriminated by `kind`. Multi-day lists are sorted, unique, one year, ≤ 31. */
export type SubmitRequestInput = SubmitCommon &
  (
    | {
        readonly kind: 'late-arrival' | 'early-departure';
        readonly date: string;
        /** Expected arrival (late) or departure (early), minutes of the day. */
        readonly expectedMinute: number;
      }
    | { readonly kind: 'wfh'; readonly dates: readonly string[] }
    | {
        readonly kind: 'annual-leave' | 'unpaid-leave';
        readonly segments: readonly LeaveSlotInput[];
      }
  );

/** Also the stored idempotency result: ids and state only, no reason or dates (ADR 0017 §4). */
export interface SubmitResult {
  readonly id: string;
  readonly state: RequestState;
  readonly version: string;
}

/** Interval [startMinute, endMinute) of one business date and its minutes (lunch excluded). */
export interface RequestSegment {
  readonly date: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly minutes: number;
}

export interface RequestDecisionView {
  readonly stage: 'lead' | 'final' | 'cancel';
  readonly decision: 'approve' | 'reject' | 'skip' | 'cancel';
  readonly actorKind: 'user' | 'system';
  readonly systemReason: 'lead_skipped_submitter_is_lead' | 'coo_self_approved' | null;
  /** UTC instant. */
  readonly decidedAt: string;
}

export interface RequestSummary {
  readonly id: string;
  readonly kind: RequestKind;
  readonly state: RequestState;
  readonly version: string;
  readonly teamId: string;
  readonly createdAt: string;
  readonly startDate: string;
  readonly endDate: string;
  /** Sum of the segments' minutes. */
  readonly minutes: number;
}

export interface RequestListView {
  readonly items: readonly RequestSummary[];
  readonly total: string;
}

export interface RequestDetailView {
  readonly id: string;
  readonly employeeId: string;
  readonly teamId: string;
  readonly kind: RequestKind;
  readonly state: RequestState;
  readonly version: string;
  readonly reason: string;
  readonly createdAt: string;
  /** Ordered by date. */
  readonly segments: readonly RequestSegment[];
  /** Decision history, oldest first; system decisions included. */
  readonly decisions: readonly RequestDecisionView[];
}

export interface RequestListQuery {
  readonly limit: number;
  readonly offset: number;
}
