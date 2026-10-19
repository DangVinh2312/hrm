import {
  hrBody,
  hrBoolean,
  hrPageQuery,
  hrText,
  hrUuid,
  hrVersion,
} from '../hr/hr-input.helper.js';
import type {
  TeamCreateInput,
  TeamLeadInput,
  TeamListQuery,
  TeamMemberInput,
  TeamMembershipRef,
  TeamRenameInput,
} from './team.types.js';

export function parseTeamList(query: unknown): TeamListQuery {
  const { limit, offset } = hrPageQuery(query);
  return { limit, offset };
}

export function parseTeamCreate(value: unknown): TeamCreateInput {
  return { name: hrText(hrBody(value, ['name']).name, 200) };
}

export function parseTeamRename(teamId: unknown, value: unknown): TeamRenameInput {
  const body = hrBody(value, ['expectedVersion', 'name']);
  return {
    teamId: hrUuid(teamId),
    expectedVersion: hrVersion(body.expectedVersion),
    name: hrText(body.name, 200),
  };
}

export function parseTeamMember(teamId: unknown, value: unknown): TeamMemberInput {
  const body = hrBody(value, ['employeeId', 'primary']);
  return {
    teamId: hrUuid(teamId),
    employeeId: hrUuid(body.employeeId),
    primary: hrBoolean(body.primary),
  };
}

export function parseMembership(teamId: unknown, employeeId: unknown): TeamMembershipRef {
  return { teamId: hrUuid(teamId), employeeId: hrUuid(employeeId) };
}

export function parseTeamLead(teamId: unknown, value: unknown): TeamLeadInput {
  const body = hrBody(value, ['employeeId']);
  return {
    teamId: hrUuid(teamId),
    employeeId: body.employeeId === null ? null : hrUuid(body.employeeId),
  };
}
