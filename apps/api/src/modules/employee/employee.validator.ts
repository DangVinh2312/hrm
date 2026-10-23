import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';
import {
  inputBody,
  inputCode,
  inputDate,
  inputMinutes,
  inputNullableDate,
  inputPageQuery,
  inputText,
  inputUuid,
  inputVersion,
} from '../../infrastructure/helpers/input-validation.helper.js';
import type {
  AccountLinkInput,
  EmployeeCreateInput,
  EmployeeClassification,
  EmployeeGender,
  EmployeeIdentityInput,
  EmployeeIdentityUpdateInput,
  EmployeeListQuery,
  EmployeeOfficialInput,
  EmployeeProfileInput,
  EmployeeTerminationInput,
  EmployeeUpdateInput,
  EmploymentStatus,
  IdentityDocumentKind,
  LeaveRateInput,
} from './employee.types.js';

/** 12 days (requirement §4.3) up to a full year of working days, in minutes. */
const MIN_ANNUAL_MINUTES = 5760;
/**
 * Rate written when an employee becomes official without one on record (ADR 0039): code-owned,
 * never user input, so the default cannot be used to raise a rate (that stays `adjustLeaveRate`).
 */
export const DEFAULT_ANNUAL_LEAVE_MINUTES = MIN_ANNUAL_MINUTES;
const MAX_ANNUAL_MINUTES = 175_680;

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value))
    throw new ProductInvalidRequest('Unexpected value');
  return value as T;
}

const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null =>
  value === null ? null : parse(value);

/**
 * Phone (ADR 0028): separators (space . - parentheses) are dropped and a leading `+84` becomes
 * `0`; the result must be national digits `0[1-9]` + 8..9 digits (10 or 11 digits). Anything else,
 * including letters, other country codes and a bare `84`, is refused rather than guessed.
 */
export function parsePhone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32)
    throw new ProductInvalidRequest('Invalid phone');
  const stripped = value.replace(/[ .\-()]/g, '');
  const national = stripped.startsWith('+84') ? `0${stripped.slice(3)}` : stripped;
  if (!/^0[1-9][0-9]{8,9}$/.test(national)) throw new ProductInvalidRequest('Invalid phone');
  return national;
}

/**
 * Work email (ADR 0028): trimmed, lowercased, ≤ 254 characters; ASCII dot-atom subset
 * (`a-z 0-9 _ + -` with single dots) and a DNS-style domain with an alphabetic TLD.
 * Display names, quotes, comments and IP literals are refused. Never used for sign-in.
 */
export function parseWorkEmail(value: unknown): string {
  if (typeof value !== 'string' || value.length > 300)
    throw new ProductInvalidRequest('Invalid email');
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[a-z0-9_+-]+(\.[a-z0-9_+-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      email,
    )
  )
    throw new ProductInvalidRequest('Invalid email');
  return email;
}

/** Position: trimmed text of 1..100 code points without control characters (same as DB CHECK). */
const parsePosition = (value: unknown): string => inputText(value, 100);

/** F1 extras: both keys present, `null` clears. */
function parseProfile(body: Record<string, unknown>): EmployeeProfileInput {
  return {
    position: nullable(body.position, parsePosition),
    classification: nullable(body.classification, (v) =>
      oneOf<EmployeeClassification>(v, ['fullTime', 'contractor']),
    ),
  };
}

/** F2 body: every field present, `null` to clear; formats match the table CHECKs. */
export function parseIdentity(value: unknown): EmployeeIdentityInput {
  const body = inputBody(value, [
    'dateOfBirth',
    'documentKind',
    'documentNumber',
    'taxCode',
    'gender',
    'phone',
    'workEmail',
  ]);
  const identity: EmployeeIdentityInput = {
    dateOfBirth: inputNullableDate(body.dateOfBirth),
    documentKind: nullable(body.documentKind, (v) =>
      oneOf<IdentityDocumentKind>(v, ['cccd', 'cmnd', 'passport']),
    ),
    documentNumber: nullable(body.documentNumber, (v) => {
      if (typeof v !== 'string' || !/^[A-Z0-9]{6,20}$/.test(v))
        throw new ProductInvalidRequest('Invalid document number');
      return v;
    }),
    taxCode: nullable(body.taxCode, (v) => {
      if (typeof v !== 'string' || !/^[0-9]{10,13}(-[0-9]{3})?$/.test(v))
        throw new ProductInvalidRequest('Invalid tax code');
      return v;
    }),
    gender: nullable(body.gender, (v) => oneOf<EmployeeGender>(v, ['male', 'female', 'other'])),
    phone: nullable(body.phone, parsePhone),
    workEmail: nullable(body.workEmail, parseWorkEmail),
  };
  if ((identity.documentKind === null) !== (identity.documentNumber === null))
    throw new ProductInvalidRequest('Document kind and number go together');
  return identity;
}

/**
 * Probation has no leave rate (ADR 0039): the field is refused there, `null` in the result. An
 * official hire may give one (bounded) and otherwise gets the code-owned default.
 */
function parseCreateRate(status: EmploymentStatus, value: unknown): number | null {
  if (status === 'probation') {
    if (value !== undefined) throw new ProductInvalidRequest('Probation has no leave rate');
    return null;
  }
  return value === undefined
    ? DEFAULT_ANNUAL_LEAVE_MINUTES
    : inputMinutes(value, MIN_ANNUAL_MINUTES, MAX_ANNUAL_MINUTES);
}

export function parseEmployeeCreate(value: unknown): EmployeeCreateInput {
  const body = inputBody(
    value,
    ['code', 'fullName', 'hiredOn', 'status', 'identity', 'position', 'classification'],
    ['annualLeaveMinutes'],
  );
  const status = oneOf<EmploymentStatus>(body.status, ['probation', 'official']);
  return {
    code: inputCode(body.code),
    fullName: inputText(body.fullName, 200),
    hiredOn: inputDate(body.hiredOn),
    status,
    annualLeaveMinutes: parseCreateRate(status, body.annualLeaveMinutes),
    identity: parseIdentity(body.identity),
    ...parseProfile(body),
  };
}

export function parseEmployeeUpdate(employeeId: unknown, value: unknown): EmployeeUpdateInput {
  const body = inputBody(value, [
    'expectedVersion',
    'code',
    'fullName',
    'position',
    'classification',
  ]);
  return {
    employeeId: inputUuid(employeeId),
    expectedVersion: inputVersion(body.expectedVersion),
    code: inputCode(body.code),
    fullName: inputText(body.fullName, 200),
    ...parseProfile(body),
  };
}

export function parseOfficial(employeeId: unknown, value: unknown): EmployeeOfficialInput {
  const body = inputBody(value, ['effectiveOn']);
  return { employeeId: inputUuid(employeeId), effectiveOn: inputDate(body.effectiveOn) };
}

export function parseTermination(employeeId: unknown, value: unknown): EmployeeTerminationInput {
  const body = inputBody(value, ['terminatedOn']);
  return { employeeId: inputUuid(employeeId), terminatedOn: inputDate(body.terminatedOn) };
}

export function parseIdentityUpdate(
  employeeId: unknown,
  value: unknown,
): EmployeeIdentityUpdateInput {
  const body = inputBody(value, ['expectedVersion', 'identity']);
  return {
    employeeId: inputUuid(employeeId),
    expectedVersion: inputVersion(body.expectedVersion),
    identity: parseIdentity(body.identity),
  };
}

export function parseLeaveRate(employeeId: unknown, value: unknown): LeaveRateInput {
  const body = inputBody(value, ['effectiveFrom', 'annualMinutes']);
  return {
    employeeId: inputUuid(employeeId),
    effectiveFrom: inputDate(body.effectiveFrom),
    annualMinutes: inputMinutes(body.annualMinutes, MIN_ANNUAL_MINUTES, MAX_ANNUAL_MINUTES),
  };
}

export function parseAccountLink(employeeId: unknown, value: unknown): AccountLinkInput {
  const body = inputBody(value, ['expectedVersion', 'accountId']);
  return {
    employeeId: inputUuid(employeeId),
    expectedVersion: inputVersion(body.expectedVersion),
    accountId: nullable(body.accountId, inputUuid),
  };
}

export function parseEmployeeList(query: unknown): EmployeeListQuery {
  const page = inputPageQuery(query, ['search']);
  const search = page.extra.search;
  return {
    limit: page.limit,
    offset: page.offset,
    ...(search === undefined || search.trim() === '' ? {} : { search: inputText(search, 100) }),
  };
}
