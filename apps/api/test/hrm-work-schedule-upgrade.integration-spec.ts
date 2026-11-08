// ADR-19: a database built before WorkSchedule is upgraded by re-running provisioning. The first
// schedule version is the old hard-coded week, existing makeup days take Monday's company hours,
// holidays and makeup days lose their weekday CHECK, and the data login gets exactly the grants
// the startup probe expects.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { DataSource } from 'typeorm';
import {
  allMigrations,
  productDataSourceOptions,
} from '../dist/database/helpers/product-database.helper.js';
import { provisionProductDatabase } from '../dist/database/services/product-database-provision.service.js';
import { verifyProductPrivileges } from '../dist/database/services/product-privilege-verify.service.js';
import { permissionPrivileges } from '../dist/modules/permission/permission-database.helper.js';
import { verifyWorkCalendarSchema } from '../dist/modules/permission/services/permission-protection-verify.service.js';
import { WorkSchedule1792108800007 } from '../dist/modules/work-schedule/work-schedule.migration.js';
import { sqlState, startPostgres, withClient, type TestPostgres } from './setup-postgres.ts';

const runtime = ['data', 'authority', 'sync'] as const;
const legacy = allMigrations.filter((m) => m !== WorkSchedule1792108800007);

let pg: TestPostgres;
let pools: Record<(typeof runtime)[number], DataSource>;

const sql = <T extends object>(statement: string, values: unknown[] = []) =>
  withClient(pg.superuser, async (c) => (await c.query<T>(statement, values)).rows);

before(async () => {
  pg = await startPostgres();
  const connections = await provisionProductDatabase(pg.superuser, pg.passwords, legacy);
  pools = {} as typeof pools;
  for (const purpose of runtime)
    pools[purpose] = await new DataSource(
      productDataSourceOptions(connections[purpose]),
    ).initialize();
});

after(async () => {
  for (const pool of Object.values(pools ?? {})) await pool.destroy();
  await pg?.stop();
});

const privileges = () =>
  verifyProductPrivileges(pools, {
    data: ['table:document:SELECT', 'column:document.title:UPDATE', ...permissionPrivileges.data],
    authority: ['table:document:SELECT', ...permissionPrivileges.authority],
    sync: [...permissionPrivileges.sync],
  });

test('provisioning again seeds the old week, backfills makeup days and keeps the probes green', async () => {
  await sql(
    `INSERT INTO work_calendar_change(version,day,kind,name) VALUES
       (2,'2026-11-07','makeup_workday',NULL),(3,'2026-11-02','paid_holiday','Fixture holiday')`,
  );
  // Before: a Saturday holiday is refused by the weekday CHECK.
  assert.equal(
    await sqlState(
      sql(
        `INSERT INTO work_calendar_change(version,day,kind,name) VALUES (4,'2026-11-14','paid_holiday','x')`,
      ),
    ),
    '23514',
  );

  await provisionProductDatabase(pg.superuser, pg.passwords, allMigrations);

  assert.deepEqual(
    await sql(`SELECT effective_from::text AS "from", count(s.*)::int AS shifts
                 FROM work_schedule w JOIN work_schedule_shift s ON s.schedule_id = w.id GROUP BY 1`),
    [{ from: '1900-01-01', shifts: 10 }],
  );
  assert.deepEqual(
    await sql(`SELECT DISTINCT weekday, position, start_minute, end_minute FROM work_schedule_shift
                ORDER BY 1, 2`),
    [1, 2, 3, 4, 5].flatMap((weekday) => [
      { weekday, position: 1, start_minute: 540, end_minute: 780 },
      { weekday, position: 2, start_minute: 840, end_minute: 1080 },
    ]),
  );
  assert.deepEqual(
    await sql(`SELECT kind, as_weekday, frame_source FROM work_calendar_change ORDER BY version`),
    [
      { kind: 'makeup_workday', as_weekday: 1, frame_source: 'company' },
      { kind: 'paid_holiday', as_weekday: null, frame_source: null },
    ],
  );
  await privileges();
  await verifyWorkCalendarSchema(pools.data);

  // Repeat is a no-op.
  await provisionProductDatabase(pg.superuser, pg.passwords, allMigrations);
  assert.equal((await sql(`SELECT 1 FROM work_schedule`)).length, 1);
  await privileges();
});

test('the data login replaces schedules by delete and insert; shifts are append-only and bounded', async () => {
  const id = randomUUID();
  await pools.data.query(`INSERT INTO work_schedule(id,effective_from) VALUES($1,'2027-01-01')`, [
    id,
  ]);
  await pools.data.query(
    `INSERT INTO work_schedule_shift(schedule_id,weekday,position,start_minute,end_minute)
     VALUES($1,1,1,510,780),($1,6,1,480,720)`,
    [id],
  );
  for (const [start, end] of [
    [541, 780],
    [780, 540],
    [540, 1445],
  ])
    assert.equal(
      await sqlState(
        pools.data.query(
          `INSERT INTO work_schedule_shift(schedule_id,weekday,position,start_minute,end_minute)
           VALUES($1,2,1,$2,$3)`,
          [id, start, end],
        ),
      ),
      '23514',
      `${start}-${end}`,
    );
  assert.equal(
    await sqlState(
      pools.data.query(
        `INSERT INTO work_schedule_shift(schedule_id,weekday,position,start_minute,end_minute)
         VALUES($1,3,4,540,780)`,
        [id],
      ),
    ),
    '23514',
  );
  assert.equal(
    await sqlState(pools.data.query(`UPDATE work_schedule_shift SET end_minute = 800`)),
    '42501',
  );
  assert.equal(
    await sqlState(
      pools.data.query(`DELETE FROM work_schedule_shift WHERE schedule_id = $1`, [id]),
    ),
    '42501',
  );
  await pools.data.query(`DELETE FROM work_schedule WHERE id = $1`, [id]);
  assert.equal(
    (await sql(`SELECT 1 FROM work_schedule_shift WHERE schedule_id = $1`, [id])).length,
    0,
  );
});

test('holidays may fall on any weekday; a makeup day always names its weekday and hours source', async () => {
  // Fixed fixture fragments only: kind, name, as_weekday, frame_source.
  const insert = (version: number, day: string, values: string) =>
    pools.data.query(
      `INSERT INTO work_calendar_change(version,day,kind,name,as_weekday,frame_source)
       VALUES (${version},'${day}',${values})`,
    );

  await insert(10, '2026-11-14', `'paid_holiday','Saturday holiday',NULL,NULL`);
  await insert(11, '2026-11-04', `'makeup_workday',NULL,3,'employee'`);
  for (const [version, values] of [
    [12, `'makeup_workday',NULL,NULL,NULL`],
    [13, `'makeup_workday',NULL,8,'company'`],
    [14, `'makeup_workday',NULL,1,'team'`],
    [15, `'standard',NULL,1,'company'`],
    [16, `'weekend',NULL,NULL,NULL`],
  ] as const)
    assert.equal(await sqlState(insert(version, '2026-11-21', values)), '23514', String(version));
});
