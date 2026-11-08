// The route guard checks only the shape of the session cookie (ADR-17): a missing or malformed
// cookie is 401 before any transaction; a well-formed cookie of no live session reaches the
// handler, whose service resolves the session under the fence and answers 401 before any data.
// Through the real AppModule over HTTP, on real PostgreSQL. Synthetic people only.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  newSessionSecret,
  sessionDigest,
} from '../dist/authentication/services/product-identity.service.js';
import { type AppHttp, startAppHttp } from './app-http.helper.ts';
import { type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';

let stack: ModuleStack;
let http: AppHttp;

before(async () => {
  stack = await startModuleStack();
  http = await startAppHttp(stack);
});

after(async () => {
  await http?.stop();
  await stack?.stop();
});

/** The response and the modes of the fenced transactions the request opened, in order. */
async function send(path: string, init: RequestInit) {
  const transactions: string[] = [];
  const run = stack.runner.run.bind(stack.runner);
  stack.runner.run = ((...args: Parameters<typeof run>) => {
    transactions.push(args[0]);
    return run(...args);
  }) as typeof stack.runner.run;
  try {
    const response = await fetch(http.origin + path, init);
    return { status: response.status, body: (await response.json()) as unknown, transactions };
  } finally {
    stack.runner.run = run;
  }
}

const refused = (status: number, code: string) => ({ statusCode: status, code });

test('a missing or malformed session cookie is 401 without any transaction', async () => {
  for (const headers of [
    http.headers(),
    http.headers('not-a-session'),
    http.headers('A'.repeat(42)),
    http.headers(`${'A'.repeat(42)}=`),
  ])
    for (const [method, path] of [
      ['GET', '/api/hr/employees'],
      ['GET', '/api/auth/me'],
      ['PATCH', `/api/hr/employees/${crypto.randomUUID()}`],
    ] as const) {
      const answer = await send(path, { method, headers, body: method === 'GET' ? null : '{}' });
      assert.deepEqual(
        answer,
        { status: 401, body: refused(401, 'error.authenticationFailed'), transactions: [] },
        `${method} ${path}`,
      );
    }
});

test('a well-formed cookie of no live session is 401 from the fenced service, never data', async () => {
  const person = await stack.person(['hr.employee', 'hr.admin']);
  const revoked = await stack.person(['hr.employee', 'hr.admin']);
  await stack.runner.run('revoke', (tx) =>
    tx.manager.query(
      'UPDATE application_session SET revoked_at=statement_timestamp() WHERE token_hash=$1',
      [sessionDigest(revoked.secret)],
    ),
  );
  // The live session reads the list in ONE transaction (the guard opens none).
  const live = await send('/api/hr/employees', { headers: http.headers(person.secret) });
  assert.equal(live.status, 200);
  assert.deepEqual(live.transactions, ['read']);
  for (const secret of [newSessionSecret(), revoked.secret])
    for (const path of ['/api/hr/employees', '/api/auth/me', '/api/hr/employees/me']) {
      const answer = await send(path, { headers: http.headers(secret) });
      assert.deepEqual(
        { status: answer.status, body: answer.body },
        { status: 401, body: refused(401, 'error.authenticationFailed') },
        path,
      );
      assert.ok(answer.transactions.length >= 1, path);
    }
});

test('accepted order change: for a dead well-formed session, CSRF is 403 and a bad body 400, before 401', async () => {
  const dead = newSessionSecret();
  const path = `/api/hr/employees/${crypto.randomUUID()}`;
  const noCsrf = Object.fromEntries(
    Object.entries(http.headers(dead)).filter(([name]) => name !== 'x-csrf-token'),
  );
  assert.deepEqual(await send(path, { method: 'PATCH', headers: noCsrf, body: '{}' }), {
    status: 403,
    body: refused(403, 'error.accessDenied'),
    transactions: [],
  });
  assert.deepEqual(await send(path, { method: 'PATCH', headers: http.headers(dead), body: '{}' }), {
    status: 400,
    body: refused(400, 'error.invalidRequest'),
    transactions: [],
  });
  const valid = JSON.stringify({
    expectedVersion: '1',
    code: 'T001',
    fullName: 'Nhân viên giả',
    position: null,
    classification: null,
  });
  const answer = await send(path, { method: 'PATCH', headers: http.headers(dead), body: valid });
  assert.deepEqual(
    { status: answer.status, body: answer.body },
    { status: 401, body: refused(401, 'error.authenticationFailed') },
  );
});

test('logout of a dead well-formed session is 401 under the shared fence, never the exclusive one', async () => {
  const revoked = await stack.person([]);
  await stack.runner.run('revoke', (tx) =>
    tx.manager.query(
      'UPDATE application_session SET revoked_at=statement_timestamp() WHERE token_hash=$1',
      [sessionDigest(revoked.secret)],
    ),
  );
  for (const secret of [newSessionSecret(), revoked.secret])
    for (const path of ['/api/auth/logout', '/api/auth/logout-all'])
      assert.deepEqual(
        await send(path, { method: 'POST', headers: http.headers(secret) }),
        { status: 401, body: refused(401, 'error.authenticationFailed'), transactions: ['read'] },
        path,
      );
  const live = await stack.person([]);
  const out = await fetch(http.origin + '/api/auth/logout', {
    method: 'POST',
    headers: http.headers(live.secret),
  });
  assert.ok(out.status < 300);
  const after = await send('/api/auth/me', { headers: http.headers(live.secret) });
  assert.equal(after.status, 401);
});

test('an admin command of a dead well-formed session is 401 from the shared-fence check, never the exclusive one', async () => {
  const target = await stack.person([]);
  assert.deepEqual(
    await send(`/api/administration/users/${target.id}/suspend`, {
      method: 'POST',
      headers: http.headers(newSessionSecret()),
    }),
    { status: 401, body: refused(401, 'error.authenticationFailed'), transactions: ['read'] },
  );
});
