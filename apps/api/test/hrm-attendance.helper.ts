// Shared fixtures of the T8 attendance integration specs: synthetic people on a disposable HR
// stack, relative business dates (never a fixed "today"), requests inserted as the owner at fixed
// past dates, and snapshots of everything an approval may write.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { ApiRejection } from '../dist/infrastructure/helpers/api-error.helper.js';
import { PermissionObjectRepository } from '../dist/modules/permission/permission-object.repository.js';
import { ProductCommandRejected } from '../dist/authorization/services/product-authority.service.js';
import type {
  ApprovalInput,
  RequestKind,
  RequestState,
  SubmitRequestInput,
} from '../dist/modules/work-request/work-request.types.js';
import { openClient } from './setup-postgres.ts';
import type { HrPerson, HrStack } from './hrm-stack.helper.ts';

const permissionObject = new PermissionObjectRepository();

export type Person = HrPerson & { employee?: string };

export const rejected = (reason: string) => (error: unknown) =>
  error instanceof ProductCommandRejected && error.reason === reason;

export const refused = (code: string, status: number) => (error: unknown) =>
  error instanceof ApiRejection && error.code === code && error.status === status;

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

export function attendanceFixture(stack: HrStack) {
  const people: Record<string, Person> = {};
  let team = '';
  let sequence = 0;
  let cursor = 1;

  const p = (name: string) => {
    const person = people[name];
    if (!person) throw new Error(`Unknown fixture person ${name}`);
    return person;
  };

  const employeeOf = (name: string) => {
    const id = p(name).employee;
    if (!id) throw new Error(`${name} has no profile`);
    return id;
  };

  const count = async (sql: string, params: unknown[] = []) =>
    Number((await stack.migration.query<{ n: string }[]>(sql, params))[0]?.n ?? 'NaN');

  async function hire(
    name: string,
    roles: readonly string[],
    options: { hiredOn?: string; inTeam?: boolean } = {},
  ) {
    const person = await stack.person(roles);
    const { id } = await stack.employees.create(await stack.freshRoot(), {
      code: `T${String(++sequence).padStart(3, '0')}`,
      fullName: `Nhân viên công giả ${sequence}`,
      hiredOn: options.hiredOn ?? '2026-01-05',
      status: 'official',
      annualLeaveMinutes: 5760,
      identity: {
        dateOfBirth: null,
        documentKind: null,
        documentNumber: null,
        taxCode: null,
        gender: null,
        phone: null,
        workEmail: null,
      },
      position: null,
      classification: null,
    });
    const [version] = await stack.migration.query<{ version: string }[]>(
      'SELECT version::text AS version FROM employee WHERE id=$1',
      [id],
    );
    assert.ok(
      await stack.employees.linkAccount(await stack.freshRoot(), {
        employeeId: id,
        expectedVersion: version!.version,
        accountId: person.id,
      }),
    );
    people[name] = { ...person, employee: id };
    if (options.inTeam ?? true)
      assert.ok(
        await stack.teams.addMember(await stack.freshRoot(), {
          teamId: team,
          employeeId: id,
          primary: true,
        }),
      );
    return people[name];
  }

  /** One team led by L1, a COO `C` and HR `H` (both also employees, not team members). */
  async function setup() {
    team = (await stack.teams.create(await stack.freshRoot(), { name: 'T1' })).id;
    await hire('L1', ['hr.employee'], { inTeam: false });
    await hire('C', ['hr.employee', 'hr.coo'], { inTeam: false });
    await hire('H', ['hr.employee', 'hr.admin'], { inTeam: false });
    assert.ok(
      await stack.teams.addMember(await stack.freshRoot(), {
        teamId: team,
        employeeId: employeeOf('L1'),
        primary: true,
      }),
    );
    assert.ok(
      await stack.teams.assignLead(await stack.freshRoot(), {
        teamId: team,
        employeeId: employeeOf('L1'),
      }),
    );
  }

  /** `n` unused Monday–Friday dates after today, all in one month (so one year). */
  async function days(n: number): Promise<string[]> {
    const found: string[] = [];
    while (found.length < n) {
      const date = await stack.day(cursor++);
      if (weekday(date) === 0 || weekday(date) === 6) continue;
      if (found[0] && found[0].slice(0, 7) !== date.slice(0, 7)) found.length = 0;
      found.push(date);
    }
    return found;
  }

  /**
   * Two consecutive unused weekdays on either side of a month boundary of the same year, inside
   * the submit window: the days of a request that spans two WFH months (D04).
   */
  async function boundary(): Promise<[string, string]> {
    let previous = await stack.day(cursor);
    for (;;) {
      const date = await stack.day(++cursor);
      if (weekday(date) === 0 || weekday(date) === 6) continue;
      if (
        previous.slice(0, 7) !== date.slice(0, 7) &&
        previous.slice(0, 4) === date.slice(0, 4) &&
        weekday(previous) !== 0 &&
        weekday(previous) !== 6
      ) {
        cursor++;
        return [previous, date];
      }
      previous = date;
    }
  }

  const wfh = (...dates: string[]) =>
    ({
      kind: 'wfh',
      teamId: null,
      reason: 'Làm tại nhà',
      dates,
    }) as const satisfies SubmitRequestInput;

  const leave = (
    kind: 'annual-leave' | 'unpaid-leave',
    date: string,
    startMinute = 540,
    endMinute = 1080,
  ) =>
    ({
      kind,
      teamId: null,
      reason: 'Việc gia đình',
      segments: [{ date, startMinute, endMinute }],
    }) as const satisfies SubmitRequestInput;

  const late = (date: string, expectedMinute = 600) =>
    ({
      kind: 'late-arrival',
      teamId: null,
      reason: 'Kẹt xe',
      date,
      expectedMinute,
    }) as const satisfies SubmitRequestInput;

  const early = (date: string, expectedMinute = 1020) =>
    ({
      kind: 'early-departure',
      teamId: null,
      reason: 'Việc riêng',
      date,
      expectedMinute,
    }) as const satisfies SubmitRequestInput;

  const submit = async (name: string, input: SubmitRequestInput, key = randomUUID()) => {
    const result = await stack.workRequests.submit(p(name).secret, key, input);
    assert.ok(result, `${name} could not submit`);
    return result;
  };

  const input = (
    request: { id: string; version: string },
    decision: 'approve' | 'reject',
    options: { version?: string; key?: string; ack?: boolean } = {},
  ): ApprovalInput => ({
    requestId: request.id,
    expectedVersion: options.version ?? request.version,
    idempotencyKey: options.key ?? randomUUID(),
    decision,
    reason: decision === 'reject' ? 'Thiếu người' : null,
    acknowledgeWfhLimit: options.ack ?? false,
  });

  /** Lead approval; the request is `pending_final` at version 2 (a late/early one is `approved`). */
  async function leadApprove(name: string, request: SubmitRequestInput) {
    const created = await submit(name, request);
    const next = await stack.approvals.decide(p('L1').secret, input(created, 'approve'));
    assert.ok(next);
    return next;
  }

  const finalDecide = (
    request: { id: string; version: string },
    decision: 'approve' | 'reject' = 'approve',
    options: { version?: string; key?: string; ack?: boolean; as?: string } = {},
  ) => stack.approvals.decide(options.as ?? p('C').secret, input(request, decision, options));

  /** Both approvals with the WFH acknowledgement: `approved` (late/early already are after the lead). */
  async function approve(name: string, request: SubmitRequestInput) {
    const next = await leadApprove(name, request);
    if (next.state === 'approved') return next;
    const done = await finalDecide(next, 'approve', { ack: true });
    assert.equal(done?.state, 'approved');
    return done;
  }

  /** HR's cancel of an approved request by default (fresh session); `as` another person's session. */
  const cancel = (
    request: { id: string; version: string },
    options: {
      version?: string;
      key?: string;
      reason?: string | null;
      as?: string;
      plain?: boolean;
    } = {},
  ) => {
    const person = p(options.as ?? 'H');
    return stack.cancellations.cancel(options.plain ? person.secret : person.fresh, {
      requestId: request.id,
      expectedVersion: options.version ?? request.version,
      idempotencyKey: options.key ?? randomUUID(),
      reason: options.reason === undefined ? 'HR đảo quyết định' : options.reason,
    });
  };

  /** Everything a cancellation may write; a refused one leaves it unchanged. */
  const cancelSnapshot = async (requestId: string) => ({
    ...(await snapshot(requestId)),
    cancelClaims: await count(
      `SELECT count(*)::text AS n FROM hr_idempotency WHERE operation = 'workRequest.cancel'`,
    ),
    cancelAudits: await count(
      `SELECT count(*)::text AS n FROM audit_outbox WHERE convert_from(event_kind,'UTF8') LIKE 'hr.request.cancel%'`,
    ),
    reversals: await count(
      `SELECT count(*)::text AS n FROM leave_ledger WHERE entry_kind = 'reversal'`,
    ),
  });

  /** Everything the approval of a request may write; a refused approval leaves it unchanged. */
  const snapshot = async (requestId: string) => ({
    request: (
      await stack.migration.query<{ state: string; version: string }[]>(
        'SELECT state, version::text AS version FROM work_request WHERE id = $1',
        [requestId],
      )
    )[0],
    decisions: await count(
      'SELECT count(*)::text AS n FROM request_decision WHERE request_id = $1',
      [requestId],
    ),
    claims: await count(
      `SELECT count(*)::text AS n FROM hr_idempotency WHERE operation = 'workRequest.decide'`,
    ),
    audits: await count(
      `SELECT count(*)::text AS n FROM audit_outbox WHERE convert_from(event_kind,'UTF8') LIKE 'hr.request.decide%'`,
    ),
    ledger: await count('SELECT count(*)::text AS n FROM leave_ledger'),
    buckets: await count('SELECT count(*)::text AS n FROM leave_bucket'),
    counters: await stack.migration.query<
      { employee: string; month: string; approved_count: number; revision: string }[]
    >(
      `SELECT employee_id::text AS employee, to_char(month,'YYYY-MM') AS month, approved_count, revision::text AS revision
         FROM wfh_month_counter ORDER BY employee_id, month`,
    ),
  });

  /** Approved WFH days of an employee in a month, from the segments (the counter's other source). */
  const approvedWfhDays = (name: string, month: string) =>
    count(
      `SELECT count(DISTINCT s.work_date)::text AS n FROM work_request r
         JOIN work_request_segment s ON s.request_id = r.id
        WHERE r.employee_id = $1 AND r.kind = 'wfh' AND r.state = 'approved'
          AND to_char(s.work_date,'YYYY-MM') = $2`,
      [employeeOf(name), month],
    );

  const counter = async (name: string, month: string) =>
    (
      await stack.migration.query<{ n: number }[]>(
        `SELECT approved_count AS n FROM wfh_month_counter WHERE employee_id = $1 AND month = CAST($2 AS date)`,
        [employeeOf(name), `${month}-01`],
      )
    )[0]?.n;

  /**
   * A request written as the owner at any dates (past ones included, which submit refuses), in any
   * state, with one segment per date. `minutes` is the segment length without lunch.
   */
  async function fixtureRequest(
    name: string,
    kind: RequestKind,
    state: RequestState,
    dates: readonly string[],
    interval: readonly [number, number] = [540, 1080],
  ): Promise<{ id: string; version: string }> {
    const id = randomUUID();
    const objectId = await stack.runner.run('write', (tx) =>
      permissionObject.register(tx, 'workRequest', id),
    );
    await stack.migration.query(
      `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
       VALUES($1,$2,$3,$4,$5,$6,$7,'Đơn thử')`,
      [id, objectId, employeeOf(name), p(name).id, team, kind, state],
    );
    const [start, end] = interval;
    const lunch = Math.max(0, Math.min(end, 840) - Math.max(start, 780));
    await stack.migration.query(
      `INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
       SELECT $1, $2, d, $3, $4, $5 FROM unnest(CAST($6 AS date[])) AS d`,
      [id, kind, start, end, end - start - lunch, dates],
    );
    return { id, version: '1' };
  }

  /** Entitlement at the end of `date`'s month = `minutes` (hired official 2026-01-05 at 5760). */
  const available = (name: string, date: string, minutes: number) =>
    stack.migration.query(
      `INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, reference)
       VALUES (gen_random_uuid(), $1, 'opening', CAST($2 AS date), $3, 'import:điều-chỉnh-thử')`,
      [employeeOf(name), `${date.slice(0, 4)}-01-01`, minutes - 480 * Number(date.slice(5, 7))],
    );

  const sheet = async (name: string, month: string, as = name) =>
    stack.attendance.period(p(as).secret, { employeeId: employeeOf(name), month });

  return {
    people,
    p,
    employeeOf,
    count,
    hire,
    setup,
    days,
    boundary,
    wfh,
    leave,
    late,
    early,
    submit,
    input,
    leadApprove,
    finalDecide,
    approve,
    cancel,
    cancelSnapshot,
    snapshot,
    approvedWfhDays,
    counter,
    fixtureRequest,
    available,
    sheet,
  };
}

/**
 * `hold` runs in an open superuser transaction; `attempts` start; the transaction commits once
 * `waiting` data-login backends wait on a lock (inside the runner's 1 s lock timeout).
 */
export async function raced<T>(
  stack: HrStack,
  hold: (client: Client) => Promise<void>,
  waiting: number,
  attempts: () => readonly Promise<T>[],
): Promise<PromiseSettledResult<T>[]> {
  const blocker = await openClient(stack.postgres.superuser);
  const watcher = await openClient(stack.postgres.superuser);
  try {
    await blocker.query('BEGIN');
    await hold(blocker);
    const settled = Promise.allSettled(attempts());
    await waitForLocks(watcher, waiting, async () => {
      await blocker.query('ROLLBACK');
      await settled;
    });
    await blocker.query('COMMIT');
    return await settled;
  } finally {
    await blocker.end();
    await watcher.end();
  }
}

/**
 * Like {@link raced} but the attempts start one at a time: attempt N+1 starts once N backends wait
 * on a lock, so they queue on the held row in the given order and, once it is released, commit in
 * that order (the row lock queue is FIFO). For races whose two outcomes differ by design, each
 * ordering is then a deterministic test instead of a coin toss decided by process timing.
 */
export async function racedInOrder<T>(
  stack: HrStack,
  hold: (client: Client) => Promise<void>,
  attempts: readonly (() => Promise<T>)[],
): Promise<PromiseSettledResult<T>[]> {
  const blocker = await openClient(stack.postgres.superuser);
  const watcher = await openClient(stack.postgres.superuser);
  try {
    await blocker.query('BEGIN');
    await hold(blocker);
    const started: Promise<PromiseSettledResult<T>>[] = [];
    for (const [index, attempt] of attempts.entries()) {
      started.push(Promise.allSettled([attempt()]).then(([result]) => result));
      await waitForLocks(watcher, index + 1, async () => {
        await blocker.query('ROLLBACK');
        await Promise.all(started);
      });
    }
    await blocker.query('COMMIT');
    return await Promise.all(started);
  } finally {
    await blocker.end();
    await watcher.end();
  }
}

/** Polls until exactly `waiting` data-login backends wait on a lock; `giveUp` runs on timeout. */
export async function waitForLocks(
  watcher: Client,
  waiting: number,
  giveUp: () => Promise<void>,
): Promise<void> {
  for (let waited = 0; ; waited += 5) {
    const { rows } = await watcher.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE datname = current_database() AND usename = 'product_data' AND state = 'active' AND wait_event_type = 'Lock'`,
    );
    if (rows[0]?.n === String(waiting)) return;
    if (waited > 800) {
      await giveUp();
      throw new Error('Barrier not reached: the operations were never in flight together');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const fulfilled = <T>(results: PromiseSettledResult<T>[]) =>
  results.filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled');

export const failures = (results: PromiseSettledResult<unknown>[]) =>
  results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r): unknown => r.reason);
