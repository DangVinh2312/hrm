// Measurement, not a CI check (ADR 0041 §7 Q17, ADR 0046): what one more pair costs in
// ProductAuthorization.permitsMany before the limit of the menu lookup is raised. It asserts NO
// timing (a loaded machine would make it flaky); it only fails if a call is refused. Off unless
// HRM_PERMITS_MEASURE=1; prints one JSON document to stdout. Synthetic data only.
//
// What is counted: `tx.manager.query` calls inside the transaction (the runner's own BEGIN, fence
// and COMMIT are constant and not counted). Time: wall clock of the whole call from the service,
// rounds interleaved so drift hits every size alike.
import assert from 'node:assert/strict';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { after, before, test } from 'node:test';
import { ProductAuthorization } from '../dist/authorization/services/product-authority.service.js';
import {
  type ProductTransaction,
  type ProductTransactionMode,
  ProductTransactionRunner,
} from '../dist/database/product-transaction.runner.js';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
  productBindings,
} from '../dist/authorization/product.manifest.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import { type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';

const enabled = process.env.HRM_PERMITS_MEASURE === '1';
const RUNS = Number(process.env.HRM_PERMITS_MEASURE_RUNS ?? 30);
const SIZES = (process.env.HRM_PERMITS_MEASURE_SIZES ?? '8,16,17,18').split(',').map(Number);

let stack: ModuleStack;

before(
  async () => {
    if (!enabled) return;
    // Own container: the timing must not share the cluster with other files.
    stack = await startModuleStack({ isolated: true });
  },
  { timeout: 300_000 },
);

after(async () => {
  await stack?.stop();
});

/** The menu pairs of EmployeeService.menus plus role.read, repeated to reach any size. */
const pairs = [
  ['team', 'read'],
  ['hrCompany', 'read'],
  ['workCalendar', 'read'],
  ['team', 'approvals'],
  ['hrCompany', 'approvals'],
  ['employee', 'reportAttendance'],
  ['employee', 'reportLateEarly'],
  ['employee', 'reportSeniority'],
  ['employee', 'reportLeave'],
  ['employee', 'reportWfh'],
  ['employee', 'reportBirthday'],
  ['account', 'read'],
  ['setting', 'read'],
  ['role', 'read'],
  ['employee', 'submitRequest'],
  ['employee', 'readLeaveBalance'],
  ['employee', 'readAttendance'],
  ['employee', 'read'],
];

const probesOf = (size: number) =>
  Array.from({ length: size }, (_, index) => {
    const [resource, action] = pairs[index % pairs.length]!;
    return { resource: resource!, action: action! };
  });

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);

  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

  return {
    runs: sorted.length,
    minMs: Number(sorted[0]!.toFixed(2)),
    medianMs: Number(at(0.5).toFixed(2)),
    p95Ms: Number(at(0.95).toFixed(2)),
    maxMs: Number(sorted.at(-1)!.toFixed(2)),
  };
};

/** Same pools and commands as the stack, with every in-transaction query counted. */
class CountingRunner extends ProductTransactionRunner {
  statements = 0;

  override run<T>(
    mode: ProductTransactionMode,
    work: (tx: ProductTransaction) => Promise<T>,
    options: { readonly serialize?: number } = {},
  ): Promise<T> {
    return super.run(
      mode,
      (tx) => {
        const original = tx.manager.query.bind(tx.manager);
        tx.manager.query = ((...args: Parameters<typeof original>) => {
          this.statements++;
          return original(...args);
        }) as typeof tx.manager.query;
        return work(tx);
      },
      options,
    );
  }
}

async function scale(measured: string) {
  // 5000 accounts, 100 runtime roles with one rule per catalog permission, one role per account.
  // The measured account keeps only its release role: a bulk role whose template does not belong to
  // the permission's resource would (rightly) make the planner deny and skip the EXISTS probe.
  const statements = [
    `INSERT INTO app_user(id,state,email_verified) SELECT gen_random_uuid(),'active',true FROM generate_series(1,5000)`,
    `INSERT INTO role_definition(role_key,managed_by,label)
       SELECT convert_to('custom.bulk'||g,'UTF8'),'runtime','Bulk '||g FROM generate_series(1,100) g`,
    `INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
       SELECT gen_random_uuid(), c.permission_key, convert_to('custom.bulk'||g,'UTF8'), 'allow',
              (SELECT template_key FROM scope_template ORDER BY template_key LIMIT 1), 1, '{}', 'runtime'
         FROM generate_series(1,100) g CROSS JOIN permission_catalog c`,
  ];
  for (const statement of statements) await stack.migration.query(statement);
  await stack.migration.query(
    `INSERT INTO user_role(user_id,role_key)
       SELECT u.id, convert_to('custom.bulk'||(1 + (row_number() OVER (ORDER BY u.id) % 100)),'UTF8')
         FROM app_user u WHERE u.kind = 'iam' AND u.id <> $1`,
    [measured],
  );
  await stack.migration.query('ANALYZE');
}

const counts = async () =>
  (
    await stack.migration.query<Record<string, string>[]>(
      `SELECT (SELECT count(*) FROM app_user)::text AS accounts, (SELECT count(*) FROM user_role)::text AS user_role,
              (SELECT count(*) FROM role_definition)::text AS roles, (SELECT count(*) FROM policy_rule)::text AS policy_rule,
              (SELECT count(*) FROM permission_catalog)::text AS permissions`,
    )
  )[0];

async function measure(label: string, secret: string) {
  const runner = new CountingRunner(stack.pools);
  const core = createProductAuthorizationCore();
  const release = createProductRelease(core);
  const audit = new ProductAuditRepository();
  const authorization = new ProductAuthorization(
    runner,
    audit,
    new ProductBindingRegistry(core, release.declarations, productBindings),
    {
      validators: { 'fresh@1': (_p, input) => input.context.freshAuthentication === true },
      obligations: createProductObligations(audit),
    },
  );
  const times = new Map<number, number[]>(SIZES.map((size) => [size, []]));
  const statements = new Map<number, number>();
  for (let round = -3; round < RUNS; round++) {
    // Rotate the order each round so no size always runs right after the same neighbour.
    const order = SIZES.map((_, index) => SIZES[(index + round + 3) % SIZES.length]!);
    for (const size of order) {
      runner.statements = 0;
      const started = performance.now();
      const answers = await authorization.permitsMany(secret, probesOf(size));
      const elapsed = performance.now() - started;
      assert.equal(answers.length, size);
      statements.set(size, runner.statements);
      if (round >= 0) times.get(size)!.push(elapsed);
    }
  }
  return {
    label,
    sizes: SIZES.map((size) => ({
      pairs: size,
      statementsInTransaction: statements.get(size),
      ...stats(times.get(size)!),
    })),
  };
}

test('permitsMany cost per pair (measurement; prints JSON, asserts no timing)', async (t) => {
  if (!enabled) return t.skip('set HRM_PERMITS_MEASURE=1');
  const admin = await stack.person(['hr.admin']);
  const results = [];
  const [version] =
    await stack.migration.query<{ server_version: string }[]>('SHOW server_version');
  const small = { data: await counts(), ...(await measure('release data only', admin.secret)) };
  results.push(small);
  await scale(admin.id);
  const large = { data: await counts(), ...(await measure('scaled data', admin.secret)) };
  results.push(large);
  console.log(
    JSON.stringify({
      environment: {
        postgres: version?.server_version,
        node: process.version,
        cpus: cpus().length,
        memoryGb: Math.round(totalmem() / 2 ** 30),
        runsPerSize: RUNS,
        warmupRounds: 3,
        container: 'disposable testcontainers PostgreSQL, same host as the client',
      },
      results,
    }),
  );
});
