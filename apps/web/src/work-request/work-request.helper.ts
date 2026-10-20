import type { MessageKey } from '../i18n/i18n.helper';
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

/** Minute of the day → `HH:MM`. */
export function minuteLabel(minute: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

/** The seven leave slots (requirement §4.3); 09:00–18:00 skips the lunch hour. */
export const leaveSlots: readonly {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}[] = [
  [540, 660],
  [660, 780],
  [840, 960],
  [960, 1080],
  [540, 780],
  [840, 1080],
  [540, 1080],
].map(([start = 0, end = 0]) => ({ value: `${start}-${end}`, start, end }));

export const isLeave = (kind: RequestKind) => kind === 'annual-leave' || kind === 'unpaid-leave';
