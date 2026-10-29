/**
 * Team contracts (T3, design §6.4): an employee may belong to several teams with exactly
 * one current primary team; a team has at most one current lead; one person may lead several.
 * Membership and lead rows are history: changes end the current row and add a new one.
 */

export interface TeamCreateInput {
  readonly name: string;
}

export interface TeamRenameInput {
  readonly teamId: string;
  readonly expectedVersion: string;
  readonly name: string;
}

/** Adds a current member. The first membership of an employee is always primary. */
export interface TeamMemberInput {
  readonly teamId: string;
  readonly employeeId: string;
  readonly primary: boolean;
}

/** Makes an existing membership the primary one, or ends it. */
export interface TeamMembershipRef {
  readonly teamId: string;
  readonly employeeId: string;
}

/** `employeeId: null` leaves the team without a lead (requests wait, design §6.4). */
export interface TeamLeadInput {
  readonly teamId: string;
  readonly employeeId: string | null;
}

export interface TeamListQuery {
  readonly limit: number;
  readonly offset: number;
}

export interface TeamPerson {
  readonly employeeId: string;
  readonly code: string;
  readonly fullName: string;
}

export interface TeamSummary {
  readonly id: string;
  readonly name: string;
  readonly lead: TeamPerson | null;
  readonly memberCount: number;
}

export interface TeamListView {
  readonly items: readonly TeamSummary[];
  readonly total: string;
}

export interface TeamMemberView extends TeamPerson {
  readonly primary: boolean;
  /** UTC instant the membership started. */
  readonly since: string;
}

export interface TeamLeadHistoryView extends TeamPerson {
  readonly startsAt: string;
  /** `null` for the current lead. */
  readonly endsAt: string | null;
}

export interface TeamView {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly lead: TeamPerson | null;
  readonly members: readonly TeamMemberView[];
  /** Newest first, at most 50 rows. */
  readonly leadHistory: readonly TeamLeadHistoryView[];
}
