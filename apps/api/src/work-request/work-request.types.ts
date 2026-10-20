/**
 * Work request contracts (T5, design §6, ADR 0018). The submitter and the employee are always
 * the session's own profile, never payload fields; a submitted request is immutable (D06).
 */

export type RequestKind =
  'late-arrival' | 'early-departure' | 'wfh' | 'annual-leave' | 'unpaid-leave';

export type RequestState = 'pending_lead' | 'pending_final' | 'approved' | 'rejected' | 'cancelled';

/** Transitions of design §6.2; `submit` is not one (it creates the request). */
export type RequestEvent =
  'lead_approve' | 'lead_reject' | 'final_approve' | 'final_reject' | 'cancel' | 'cancel_approved';

/** §6.4.1: `lead` = Team Lead only (late/early), `lead-final` = Team Lead then COO. */
export type ApprovalChain = 'lead' | 'lead-final';

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

/**
 * A decision on a request (T6, design §6.2). Stage and actor come from the server: the stage is
 * the request's current state, the actor the session.
 */
export interface ApprovalInput {
  readonly requestId: string;
  readonly expectedVersion: string;
  /** `Idempotency-Key` header (lowercase UUID v4), bound to actor, operation and payload. */
  readonly idempotencyKey: string;
  readonly decision: 'approve' | 'reject';
  /** Required to reject (D08), an optional note to approve; 1..1000 code points. */
  readonly reason: string | null;
}

/**
 * Also the stored idempotency result of submit and decide: ids and state only, no reason or
 * dates (ADR 0017 §4).
 */
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
  /** The approver's reason (always set on a reject, D08); `null` for system decisions. */
  readonly reason: string | null;
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

/** A request the caller may decide now; the employee is resolved through employee.read. */
export interface ApprovalQueueItem extends RequestSummary {
  readonly employeeId: string;
}

export interface ApprovalQueueView {
  readonly items: readonly ApprovalQueueItem[];
  readonly total: string;
}

/**
 * A request decided in the caller's approval scope (T6 part C) and its latest lead/final
 * decision; no reason and no decider id (the queues return neither). Release 9 adds the owner's
 * full name (`employeeName`), for the rows the caller may read only.
 */
export interface DecidedRequestItem extends ApprovalQueueItem {
  readonly employeeName: string;
  readonly decision: Pick<RequestDecisionView, 'stage' | 'decision' | 'actorKind' | 'decidedAt'>;
}

export interface DecidedRequestsView {
  readonly items: readonly DecidedRequestItem[];
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
