import { HrResource } from '../hr-authorization.types.js';
import { HR_COMPANY_ID, WORK_CALENDAR_ID } from '../helpers/hr-database.helper.js';
import type { ProductTransaction } from '../../../database/product-transaction.runner.js';

/**
 * Object registry writes of the HR module: the code-owned singleton anchors (sync login) and the
 * registration of new records through `hr_register_object`. No state; the transaction comes in
 * through each method.
 */
export class HrObjectRepository {
  /**
   * Creates a code-owned singleton anchor once, after the release that declares its resource is
   * applied (its object_ref needs the resource type). Idempotent DML of a constant, run by the sync
   * login next to the manifest; readiness only checks that it exists. Identifiers are fixed here.
   */
  async #ensureAnchor(
    tx: ProductTransaction,
    anchor: {
      readonly type: 'hrCompany' | 'workCalendar';
      readonly table: string;
      readonly id: string;
    },
  ): Promise<void> {
    await tx.manager.query(
      `WITH registered AS (
       INSERT INTO object_ref(object_id,type_key,key_kind,key_bytes)
         VALUES (gen_random_uuid(), convert_to($2,'UTF8'), 'uuid', convert_to(CAST($1 AS text),'UTF8'))
         ON CONFLICT (type_key,key_kind,key_bytes) DO NOTHING RETURNING object_id)
     INSERT INTO ${anchor.table}(id,object_id) SELECT CAST(CAST($1 AS text) AS uuid), object_id FROM registered
       ON CONFLICT DO NOTHING`,
      [anchor.id, anchor.type],
    );
    const [row] = await tx.manager.query<{ ok: boolean }[]>(
      `SELECT EXISTS(SELECT 1 FROM ${anchor.table} c JOIN object_ref o ON o.object_id=c.object_id
       WHERE c.id=CAST(CAST($1 AS text) AS uuid) AND o.type_key=convert_to($2,'UTF8')
         AND o.key_bytes=convert_to(CAST($1 AS text),'UTF8')) AS ok`,
      [anchor.id, anchor.type],
    );
    if (!row?.ok) throw new Error(`${anchor.type} anchor is inconsistent`);
  }

  /** The company anchor, parent of company-level creates (design §7.2). */
  ensureHrCompany(tx: ProductTransaction): Promise<void> {
    return this.#ensureAnchor(tx, { type: 'hrCompany', table: 'hr_company', id: HR_COMPANY_ID });
  }

  /** The work calendar anchor at version 1 (standard week, no holiday) on first creation. */
  ensureWorkCalendar(tx: ProductTransaction): Promise<void> {
    return this.#ensureAnchor(tx, {
      type: 'workCalendar',
      table: 'work_calendar',
      id: WORK_CALENDAR_ID,
    });
  }

  /** Registers a new HR record in the object registry (create on an authorized parent). */
  async register(
    tx: ProductTransaction,
    resource: Exclude<HrResource, typeof HrResource.Company>,
    key: string,
  ): Promise<string> {
    const [row] = await tx.manager.query<{ object_id: string }[]>(
      'SELECT public.hr_register_object($1,CAST($2 AS uuid))::text AS object_id',
      [resource, key],
    );
    if (!row) throw new Error('Object registration returned no row');
    return row.object_id;
  }
}
