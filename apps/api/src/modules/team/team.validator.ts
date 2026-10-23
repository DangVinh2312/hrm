import {
  inputBody,
  inputBoolean,
  inputPageQuery,
  inputText,
  inputUuid,
  inputVersion,
} from '../../infrastructure/helpers/input-validation.helper.js';
import type {
  TeamCreateInput,
  TeamLeadInput,
  TeamListQuery,
  TeamMemberInput,
  TeamMembershipRef,
  TeamRenameInput,
} from './team.types.js';

export function parseTeamList(query: unknown): TeamListQuery {
  const { limit, offset } = inputPageQuery(query);
  return { limit, offset };
}

export function parseTeamCreate(value: unknown): TeamCreateInput {
  return { name: inputText(inputBody(value, ['name']).name, 200) };
}

export function parseTeamRename(teamId: unknown, value: unknown): TeamRenameInput {
  const body = inputBody(value, ['expectedVersion', 'name']);
  return {
    teamId: inputUuid(teamId),
    expectedVersion: inputVersion(body.expectedVersion),
    name: inputText(body.name, 200),
  };
}

export function parseTeamMember(teamId: unknown, value: unknown): TeamMemberInput {
  const body = inputBody(value, ['employeeId', 'primary']);
  return {
    teamId: inputUuid(teamId),
    employeeId: inputUuid(body.employeeId),
    primary: inputBoolean(body.primary),
  };
}

export function parseMembership(teamId: unknown, employeeId: unknown): TeamMembershipRef {
  return { teamId: inputUuid(teamId), employeeId: inputUuid(employeeId) };
}

export function parseTeamLead(teamId: unknown, value: unknown): TeamLeadInput {
  const body = inputBody(value, ['employeeId']);
  return {
    teamId: inputUuid(teamId),
    employeeId: body.employeeId === null ? null : inputUuid(body.employeeId),
  };
}
