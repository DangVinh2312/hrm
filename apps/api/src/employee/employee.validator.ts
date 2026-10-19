import { ProductInvalidRequest } from '../authorization/product-data.gateway.js';
import {
  hrBody,
  hrCode,
  hrDate,
  hrMinutes,
  hrNullableDate,
  hrPageQuery,
  hrText,
  hrUuid,
  hrVersion,
} from '../hr/hr-input.helper.js';
import type {
  AccountLinkInput,
  EmployeeCreateInput,
  EmployeeIdentityInput,
  EmployeeIdentityUpdateInput,
  EmployeeListQuery,
  EmployeeOfficialInput,
  EmployeeTerminationInput,
  EmployeeUpdateInput,
  EmploymentStatus,
  IdentityDocumentKind,
  LeaveRateInput,
} from './employee.types.js';

/** 12 days (requirement §4.3) up to a full year of working days, in minutes. */
const MIN_ANNUAL_MINUTES = 5760;
const MAX_ANNUAL_MINUTES = 175_680;

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value))
    throw new ProductInvalidRequest('Unexpected value');
  return value as T;
}

const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null =>
  value === null ? null : parse(value);

/** F2 body: every field present, `null` to clear; formats match the table CHECKs. */
export function parseIdentity(value: unknown): EmployeeIdentityInput {
  const body = hrBody(value, ['dateOfBirth', 'documentKind', 'documentNumber', 'taxCode']);
  const identity: EmployeeIdentityInput = {
    dateOfBirth: hrNullableDate(body.dateOfBirth),
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
  };
  if ((identity.documentKind === null) !== (identity.documentNumber === null))
    throw new ProductInvalidRequest('Document kind and number go together');
  return identity;
}

export function parseEmployeeCreate(value: unknown): EmployeeCreateInput {
  const body = hrBody(value, [
    'code',
    'fullName',
    'hiredOn',
    'status',
    'annualLeaveMinutes',
    'identity',
  ]);
  return {
    code: hrCode(body.code),
    fullName: hrText(body.fullName, 200),
    hiredOn: hrDate(body.hiredOn),
    status: oneOf<EmploymentStatus>(body.status, ['probation', 'official']),
    annualLeaveMinutes: hrMinutes(body.annualLeaveMinutes, MIN_ANNUAL_MINUTES, MAX_ANNUAL_MINUTES),
    identity: parseIdentity(body.identity),
  };
}

export function parseEmployeeUpdate(employeeId: unknown, value: unknown): EmployeeUpdateInput {
  const body = hrBody(value, ['expectedVersion', 'code', 'fullName']);
  return {
    employeeId: hrUuid(employeeId),
    expectedVersion: hrVersion(body.expectedVersion),
    code: hrCode(body.code),
    fullName: hrText(body.fullName, 200),
  };
}

export function parseOfficial(employeeId: unknown, value: unknown): EmployeeOfficialInput {
  const body = hrBody(value, ['effectiveOn']);
  return { employeeId: hrUuid(employeeId), effectiveOn: hrDate(body.effectiveOn) };
}

export function parseTermination(employeeId: unknown, value: unknown): EmployeeTerminationInput {
  const body = hrBody(value, ['terminatedOn']);
  return { employeeId: hrUuid(employeeId), terminatedOn: hrDate(body.terminatedOn) };
}

export function parseIdentityUpdate(
  employeeId: unknown,
  value: unknown,
): EmployeeIdentityUpdateInput {
  const body = hrBody(value, ['expectedVersion', 'identity']);
  return {
    employeeId: hrUuid(employeeId),
    expectedVersion: hrVersion(body.expectedVersion),
    identity: parseIdentity(body.identity),
  };
}

export function parseLeaveRate(employeeId: unknown, value: unknown): LeaveRateInput {
  const body = hrBody(value, ['effectiveFrom', 'annualMinutes']);
  return {
    employeeId: hrUuid(employeeId),
    effectiveFrom: hrDate(body.effectiveFrom),
    annualMinutes: hrMinutes(body.annualMinutes, MIN_ANNUAL_MINUTES, MAX_ANNUAL_MINUTES),
  };
}

export function parseAccountLink(employeeId: unknown, value: unknown): AccountLinkInput {
  const body = hrBody(value, ['expectedVersion', 'accountId']);
  return {
    employeeId: hrUuid(employeeId),
    expectedVersion: hrVersion(body.expectedVersion),
    accountId: nullable(body.accountId, hrUuid),
  };
}

export function parseEmployeeList(query: unknown): EmployeeListQuery {
  const page = hrPageQuery(query, ['search']);
  const search = page.extra.search;
  return {
    limit: page.limit,
    offset: page.offset,
    ...(search === undefined || search.trim() === '' ? {} : { search: hrText(search, 100) }),
  };
}
