import type { EntityManager } from 'typeorm';
import {
  type LeaveEmployeeFacts,
  type LeaveFactsRow,
  leaveFactsColumns,
  leaveFactsOf,
} from '../helpers/leave-facts.helper.js';

export class LeaveFactsRepository {
  /**
   * Facts of `employeeIds` for `year` from one statement (see {@link leaveFactsColumns}). Bounded by
   * the caller's id list (≤ 100) and by the year's rows of those employees.
   */
  async loadLeaveFacts(
    manager: EntityManager,
    employeeIds: readonly string[],
    year: number,
  ): Promise<ReadonlyMap<string, LeaveEmployeeFacts>> {
    const rows = await manager.query<(LeaveFactsRow & { id: string })[]>(
      `SELECT e.id::text AS id, ${leaveFactsColumns('e', 'CAST($2 AS int)')}
       FROM employee e WHERE e.id = ANY(CAST($1 AS uuid[]))`,
      [[...employeeIds], year],
    );
    return new Map(rows.map((row) => [row.id, leaveFactsOf(row, year)]));
  }
}
