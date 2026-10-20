import { z } from 'zod';
import type { HttpClient } from '../infrastructure/http.client';

const version = z.string().regex(/^[1-9][0-9]{0,17}$/);
const kind = z.enum(['late-arrival', 'early-departure', 'wfh', 'annual-leave', 'unpaid-leave']);
const state = z.enum(['pending_lead', 'pending_final', 'approved', 'rejected', 'cancelled']);
export type RequestKind = z.infer<typeof kind>;

export type RequestState = z.infer<typeof state>;

/** `GET /api/hr/requests` (T5): own requests, newest first. */
const summarySchema = z.object({
  id: z.uuid(),
  kind,
  state,
  version,
  teamId: z.uuid(),
  createdAt: z.string(),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  minutes: z.number().int().min(0),
});
export type RequestSummary = z.infer<typeof summarySchema>;
const listSchema = z.object({ items: z.array(summarySchema).max(100), total: z.string() });
export type RequestList = z.infer<typeof listSchema>;

/** `GET /api/hr/requests/:id`: segments and decision history exactly as the API returns them. */
const detailSchema = z.object({
  id: z.uuid(),
  employeeId: z.uuid(),
  teamId: z.uuid(),
  kind,
  state,
  version,
  reason: z.string(),
  createdAt: z.string(),
  segments: z
    .array(
      z.object({
        date: z.iso.date(),
        startMinute: z.number().int(),
        endMinute: z.number().int(),
        minutes: z.number().int(),
      }),
    )
    .max(31),
  decisions: z
    .array(
      z.object({
        stage: z.enum(['lead', 'final', 'cancel']),
        decision: z.enum(['approve', 'reject', 'skip', 'cancel']),
        actorKind: z.enum(['user', 'system']),
        systemReason: z.enum(['lead_skipped_submitter_is_lead', 'coo_self_approved']).nullable(),
        decidedAt: z.string(),
      }),
    )
    .max(20),
});
export type RequestDetail = z.infer<typeof detailSchema>;

/** `GET /api/hr/approvals/{lead,final}` (T6): waiting requests, oldest first; ids, no names. */
const queueSchema = z.object({
  items: z.array(summarySchema.extend({ employeeId: z.uuid() })).max(100),
  total: z.string(),
});
export type ApprovalQueue = z.infer<typeof queueSchema>;

export type ApprovalQueueItem = ApprovalQueue['items'][number];

export type ApprovalStage = 'lead' | 'final';

/**
 * `GET /api/hr/approvals/decided` (T6 part C): requests decided in the caller's approval scope,
 * latest decision first, each with that decision; no reason, no decider.
 */
const decidedSchema = z.object({
  items: z
    .array(
      summarySchema.extend({
        employeeId: z.uuid(),
        employeeName: z.string(),
        decision: z.object({
          stage: z.enum(['lead', 'final']),
          decision: z.enum(['approve', 'reject', 'skip']),
          actorKind: z.enum(['user', 'system']),
          decidedAt: z.string(),
        }),
      }),
    )
    .max(100),
  total: z.string(),
});
export type DecidedRequests = z.infer<typeof decidedSchema>;

export type DecidedRequestItem = DecidedRequests['items'][number];

/** Body of `POST /api/hr/requests/:id/decision`; the stage follows the stored state, never sent. */
export interface DecisionInput {
  readonly expectedVersion: string;
  readonly decision: 'approve' | 'reject';
  /** Required to reject (D08), an optional note to approve. */
  readonly reason: string | null;
}

const resultSchema = z.object({ id: z.uuid(), state, version });
export type SubmitResult = z.infer<typeof resultSchema>;

export interface LeaveSlot {
  readonly date: string;
  readonly startMinute: number;
  readonly endMinute: number;
}

/** Body of `POST /api/hr/requests`; employee and owner are the session's, never sent. */
export type SubmitInput = { readonly reason: string } & (
  | {
      readonly kind: 'late-arrival' | 'early-departure';
      readonly date: string;
      readonly expectedMinute: number;
    }
  | { readonly kind: 'wfh'; readonly dates: readonly string[] }
  | { readonly kind: 'annual-leave' | 'unpaid-leave'; readonly segments: readonly LeaveSlot[] }
);

export const REQUEST_PAGE_SIZE = 20;

export interface WorkRequestClient {
  /** The same `idempotencyKey` with the same input returns the first result (API spec §10.3). */
  submit(input: SubmitInput, idempotencyKey: string): Promise<SubmitResult>;

  list(query: { page: number }, signal?: AbortSignal): Promise<RequestList>;

  detail(id: string, signal?: AbortSignal): Promise<RequestDetail>;

  queue(
    stage: ApprovalStage,
    query: { page: number },
    signal?: AbortSignal,
  ): Promise<ApprovalQueue>;

  decided(query: { page: number }, signal?: AbortSignal): Promise<DecidedRequests>;

  /** Same contract as `submit`: one key per distinct decision, reused on retry. */
  decide(id: string, input: DecisionInput, idempotencyKey: string): Promise<SubmitResult>;
}

const pageQuery = (page: number) =>
  new URLSearchParams({
    limit: String(REQUEST_PAGE_SIZE),
    offset: String((page - 1) * REQUEST_PAGE_SIZE),
  });

export function createWorkRequestClient(http: HttpClient): WorkRequestClient {
  return {
    submit: (input, idempotencyKey) =>
      http.request('/api/hr/requests', resultSchema, {
        method: 'POST',
        body: input,
        headers: { 'idempotency-key': idempotencyKey },
      }),
    list: ({ page }, signal) =>
      http.request(`/api/hr/requests?${pageQuery(page)}`, listSchema, signal ? { signal } : {}),
    detail: (id, signal) =>
      http.request(
        `/api/hr/requests/${encodeURIComponent(id)}`,
        detailSchema,
        signal ? { signal } : {},
      ),
    queue: (stage, { page }, signal) =>
      http.request(
        `/api/hr/approvals/${stage}?${pageQuery(page)}`,
        queueSchema,
        signal ? { signal } : {},
      ),
    decided: ({ page }, signal) =>
      http.request(
        `/api/hr/approvals/decided?${pageQuery(page)}`,
        decidedSchema,
        signal ? { signal } : {},
      ),
    decide: (id, input, idempotencyKey) =>
      http.request(`/api/hr/requests/${encodeURIComponent(id)}/decision`, resultSchema, {
        method: 'POST',
        body: input,
        headers: { 'idempotency-key': idempotencyKey },
      }),
  };
}
