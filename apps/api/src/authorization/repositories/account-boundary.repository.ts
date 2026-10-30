import { QueryFailedError, type EntityManager } from 'typeorm';
import { type BoundaryRef, MAX_BOUNDARY_PACKAGE } from '../helpers/boundary-binding.helper.js';

const utf8 = (value: string) => Buffer.from(value, 'utf8');

/**
 * Statements of `account.bindBoundary` / `account.unbindBoundary`. Every method takes the manager
 * of the command and runs inside its `admin` transaction, after the exclusive fence; nothing here
 * decides who may do what.
 */
export class AccountBoundaryRepository {
  /**
   * The permissions of an active boundary, each with whether the catalog marks it `required`. At
   * most `MAX_BOUNDARY_PACKAGE + 1` rows: more than the limit is a package the command refuses.
   * Empty for a boundary that is unknown, not `active` or without entries.
   */
  async packageOf(
    manager: EntityManager,
    ref: BoundaryRef,
  ): Promise<{ permission: string; required: boolean }[]> {
    return manager.query<{ permission: string; required: boolean }[]>(
      `SELECT convert_from(e.permission_key,'UTF8') AS permission, c.boundary_requirement = 'required' AS required
         FROM permission_boundary d
         JOIN permission_boundary_entry e ON e.boundary_key = d.boundary_key AND e.boundary_version = d.boundary_version
         JOIN permission_catalog c ON c.permission_key = e.permission_key
        WHERE d.boundary_key = $1 AND d.boundary_version = $2 AND d.lifecycle = 'active'
        ORDER BY e.permission_key LIMIT ${MAX_BOUNDARY_PACKAGE + 1}`,
      [utf8(ref.key), ref.version],
    );
  }

  /**
   * In one statement: how many permissions of `ref` the actor is bound to and how many permissions
   * of the package the target is bound to under any boundary (one binding per user and permission).
   */
  async bindingsOf(
    manager: EntityManager,
    actor: string,
    target: string,
    ref: BoundaryRef,
  ): Promise<{ actorHeld: number; targetBound: number }> {
    const [row] = await manager.query<{ actor_held: number; target_bound: number }[]>(
      `SELECT (SELECT count(*)::int FROM user_boundary
                WHERE user_id = $1 AND boundary_key = $3 AND boundary_version = $4) AS actor_held,
              (SELECT count(*)::int FROM user_boundary b
                WHERE b.user_id = $2 AND b.permission_key IN (
                  SELECT permission_key FROM permission_boundary_entry
                   WHERE boundary_key = $3 AND boundary_version = $4)) AS target_bound`,
      [actor, target, utf8(ref.key), ref.version],
    );
    return { actorHeld: row?.actor_held ?? 0, targetBound: row?.target_bound ?? 0 };
  }

  /**
   * The whole package in one INSERT, as runtime rows (`seed_owner` stays NULL). The rows written;
   * `undefined` when a row exists already (the primary key decides, whatever was read before).
   */
  async insert(
    manager: EntityManager,
    target: string,
    ref: BoundaryRef,
  ): Promise<number | undefined> {
    try {
      const rows = await manager.query<unknown[]>(
        `INSERT INTO user_boundary(user_id, permission_key, boundary_key, boundary_version)
         SELECT $1, e.permission_key, e.boundary_key, e.boundary_version
           FROM permission_boundary_entry e WHERE e.boundary_key = $2 AND e.boundary_version = $3
         RETURNING 1`,
        [target, utf8(ref.key), ref.version],
      );
      return rows.length;
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: unknown } | undefined)?.code === '23505'
      )
        return undefined;
      throw error;
    }
  }

  /** Deletes the runtime rows of the package; rows with a `seed_owner` are never named. */
  async deleteRuntime(manager: EntityManager, target: string, ref: BoundaryRef): Promise<number> {
    // A data-modifying CTE: the driver returns a bare DELETE as `[rows, count]`, not as rows.
    const [row] = await manager.query<{ gone: number }[]>(
      `WITH gone AS (DELETE FROM user_boundary
                      WHERE user_id = $1 AND boundary_key = $2 AND boundary_version = $3 AND seed_owner IS NULL
                  RETURNING 1)
       SELECT count(*)::int AS gone FROM gone`,
      [target, utf8(ref.key), ref.version],
    );
    return row?.gone ?? 0;
  }
}
