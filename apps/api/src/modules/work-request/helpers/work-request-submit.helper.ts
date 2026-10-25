import { createHash } from 'node:crypto';
import type { ApiRejectionCode } from '../../../infrastructure/helpers/api-error.helper.js';
import type { SubmitRequestInput, SubmitResult } from '../work-request.types.js';
import { SettingKey } from '../../setting/setting.registry.js';
import type { WorkRequestRejection } from './work-request.helper.js';

/**
 * Rules with their own key (HTTP 422, api-error.helper.ts). Each is over facts the submitter may
 * know: the D06 window and the year, their own status on the day, the calendar every HR role
 * reads. The others stay the generic invalid request (400): a time outside a shift or a non-slot
 * interval (fixed rules on the input alone; acceptance A-17/B-21 keep 400) and a day outside
 * employment (only reachable around a hire or leaving date; no acceptance case asks for its own
 * key — add one with its justification when a screen needs it).
 */
export const ruleCodes: Readonly<Record<WorkRequestRejection, ApiRejectionCode | undefined>> = {
  crosses_year: 'error.crossesYear',
  date_out_of_range: 'error.dateOutOfRange',
  kind_not_allowed_in_probation: 'error.kindNotAllowedInProbation',
  non_working_day: 'error.nonWorkingDay',
  makeup_day: 'error.makeupDay',
  not_employed: undefined,
  invalid_time: undefined,
  invalid_slot: undefined,
};

/**
 * Same actor, operation, key and payload already committed: the transaction rolls back (nothing
 * to write) and the stored result is returned. Thrown after the plan matched and locked the
 * employee row, so the permission is the current one (C-19).
 */
export class SubmitReplayed extends Error {
  constructor(readonly result: SubmitResult) {
    super('Submit replayed');
  }
}

/** The locked employee is not the session's own profile any more: not found (404), no write. */
export class SubmitterNotFound extends Error {}

/** SHA-256 of the validated body; the validator emits keys in a fixed order. */
export const payloadHash = (input: SubmitRequestInput) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');

/** The settings one submit reads, in one statement (ADR 0041 §5): window, size, WFH warning limit. */
export const submitRuleKeys = [
  SettingKey.RequestWindowPastDays,
  SettingKey.RequestWindowFutureDays,
  SettingKey.RequestMaxDays,
  SettingKey.WfhMonthLimit,
] as const;
