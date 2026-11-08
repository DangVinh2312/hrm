import type { Frame } from '../../components/week-frames.helper';
import { formatDate } from '../../i18n/format.helper';
import type { MessageKey } from '../../i18n/i18n.helper';
import type { RequestKind, RequestState } from './work-request.client';

export const kindKeys: Readonly<Record<RequestKind, MessageKey>> = {
  'late-arrival': 'request.kind.lateArrival',
  'early-departure': 'request.kind.earlyDeparture',
  wfh: 'request.kind.wfh',
  'annual-leave': 'request.kind.annualLeave',
  'unpaid-leave': 'request.kind.unpaidLeave',
};

export const stateKeys: Readonly<Record<RequestState, MessageKey>> = {
  pending_lead: 'request.state.pendingLead',
  pending_final: 'request.state.pendingFinal',
  approved: 'request.state.approved',
  rejected: 'request.state.rejected',
  cancelled: 'request.state.cancelled',
};

export const requestKinds = Object.keys(kindKeys) as RequestKind[];

export type LeaveSlot = { readonly value: string; readonly start: number; readonly end: number };

/**
 * Leave choices on a day with `shifts` (ADR-19): each shift split at its middle round hour, each
 * whole shift, then the whole day (breaks between shifts are not leave). With the seeded week these
 * are the seven slots of requirement §4.3. The API checks the edges again.
 */
export function leaveSlots(shifts: Frame): readonly LeaveSlot[] {
  const halves = shifts.flatMap(([start, end]): [number, number][] => {
    const middle = Math.round((start + end) / 120) * 60;
    return middle > start && middle < end
      ? [
          [start, middle],
          [middle, end],
        ]
      : [];
  });
  const first = shifts[0];
  const last = shifts.at(-1);
  const day: [number, number][] = first && last ? [[first[0], last[1]]] : [];
  const slots = new Map<string, LeaveSlot>();
  for (const [start, end] of [...halves, ...shifts, ...day])
    slots.set(`${start}-${end}`, { value: `${start}-${end}`, start, end });
  return [...slots.values()];
}

/** `start-end` of a chosen slot. */
export function slotOf(value: string): { start: number; end: number } | undefined {
  const match = /^(\d{1,4})-(\d{1,4})$/.exec(value);
  return match ? { start: Number(match[1]), end: Number(match[2]) } : undefined;
}

export const isLeave = (kind: RequestKind) => kind === 'annual-leave' || kind === 'unpaid-leave';

/** `?page=` lives in the URL (design §10.3); the API caps the offset, so does this. */
export function pageFrom(params: URLSearchParams): number {
  const page = Number(params.get('page') ?? '1');
  return Number.isSafeInteger(page) && page >= 1 && page <= 500 ? page : 1;
}

export const dateRange = (start: string, end: string) =>
  start === end ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`;
