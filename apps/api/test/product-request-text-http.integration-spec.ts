// Text a request may carry (ADR-21), through the real AppModule over HTTP on real PostgreSQL: a
// JSON body with a lone surrogate anywhere, or bytes that are not UTF-8, is 400 before any
// transaction; a surrogate pair and multi-byte UTF-8 are kept as sent; a sign-in email outside printable ASCII is 400 for provisioning and for the email
// change. Synthetic people only.
import assert from 'node:assert/strict';
import { isUtf8 } from 'node:buffer';
import { after, before, test } from 'node:test';
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

/** The response and the modes of the fenced transactions the request opened. */
async function send(
  method: string,
  path: string,
  secret: string,
  body: string | Uint8Array<ArrayBuffer>,
  contentType = 'application/json',
) {
  const transactions: string[] = [];
  const run = stack.runner.run.bind(stack.runner);
  stack.runner.run = ((...args: Parameters<typeof run>) => {
    transactions.push(args[0]);
    return run(...args);
  }) as typeof stack.runner.run;
  try {
    const response = await fetch(http.origin + path, {
      method,
      headers: { ...http.headers(secret), 'content-type': contentType },
      body,
    });
    return { status: response.status, body: (await response.json()) as unknown, transactions };
  } finally {
    stack.runner.run = run;
  }
}

const invalid = { status: 400, body: { statusCode: 400, code: 'error.invalidRequest' } };

const teams = async () =>
  (await stack.migration.query<{ name: string }[]>('SELECT name FROM team ORDER BY name')).map(
    (row) => row.name,
  );

test('a lone surrogate in any key or string of the body is 400 before any transaction', async () => {
  const secret = await stack.freshRoot();
  const before = await teams();
  for (const body of [
    '{"name":"\\ud83d"}',
    '{"name":"a\\udc00b"}',
    '{"\\ud83d":"Lone key"}',
    '{"name":"Nested","extra":{"list":["ok",{"deep":"\\udfff"}]}}',
    '["\\ud800"]',
  ]) {
    const { transactions, ...answer } = await send('POST', '/api/hr/teams', secret, body);
    assert.deepEqual(answer, invalid, body);
    assert.deepEqual(transactions, [], body);
  }
  assert.deepEqual(await teams(), before);
});

test('a surrogate pair and an escaped backslash are text like any other', async () => {
  const secret = await stack.freshRoot();
  const created = await send(
    'POST',
    '/api/hr/teams',
    secret,
    '{"name":"Nh\\u00f3m \\ud83d\\ude00"}',
  );
  assert.equal(created.status, 201);
  const literal = await send('POST', '/api/hr/teams', secret, '{"name":"Team \\\\ud83d"}');
  assert.equal(literal.status, 201);
  const names = await teams();
  assert.ok(names.includes('Nh\u00f3m \u{1f600}'));
  assert.ok(names.includes('Team \\ud83d'));
});

test('a sign-in email outside printable ASCII is 400 for provisioning and for the email change', async () => {
  const secret = await stack.freshRoot();
  const target = await stack.person(['hr.employee']);

  const accounts = () =>
    stack.migration.query<{ email: string | null }[]>(
      'SELECT email_canonical email FROM app_user ORDER BY id',
    );

  const before = await accounts();
  for (const email of [
    '\u212aim@example.test',
    '\u0130@example.test',
    'kim@ex\u00e4mple.test',
    'kim\u0001@example.test',
  ]) {
    const provisioned = await send(
      'POST',
      '/api/administration/accounts',
      secret,
      JSON.stringify({ email, roleKey: 'hr.employee' }),
    );
    assert.deepEqual({ status: provisioned.status, body: provisioned.body }, invalid, email);
    const changed = await send(
      'PUT',
      `/api/administration/accounts/${target.id}/email`,
      secret,
      JSON.stringify({ email }),
    );
    assert.deepEqual({ status: changed.status, body: changed.body }, invalid, email);
  }
  assert.deepEqual(await accounts(), before);
});

const utf8 = (...parts: (string | number[])[]) =>
  Buffer.concat(
    parts.map((part) => (typeof part === 'string' ? Buffer.from(part) : Buffer.from(part))),
  );

test('a JSON body that is not valid UTF-8 is 400 before any transaction', async () => {
  const secret = await stack.freshRoot();
  const before = await teams();
  for (const bytes of [
    [0xe2, 0x82],
    [0xf0, 0x9f, 0x98],
    [0xff],
    [0xc0, 0xaf],
    [0xed, 0xa0, 0xbd],
  ]) {
    const { transactions, ...answer } = await send(
      'POST',
      '/api/hr/teams',
      secret,
      utf8('{"name":"Team ', bytes, '"}'),
    );
    assert.deepEqual(answer, invalid, String(bytes));
    assert.deepEqual(transactions, [], String(bytes));
  }
  for (const charset of ['utf-8', 'UTF-8', 'utf-8-', 'utf-8:1234']) {
    const declared = await send(
      'POST',
      '/api/hr/teams',
      secret,
      utf8('{"name":"Team ', [0xff], '"}'),
      `application/json; charset=${charset}`,
    );
    assert.deepEqual({ status: declared.status, body: declared.body }, invalid, charset);
  }
  assert.deepEqual(await teams(), before);
});

test('multi-byte UTF-8 is kept as sent', async () => {
  const secret = await stack.freshRoot();
  const name = 'Nguy\u1ec5n \u{1f600}';
  const created = await send('POST', '/api/hr/teams', secret, utf8(`{"name":"${name}"}`));
  assert.equal(created.status, 201);
  assert.ok((await teams()).includes(name));
});

test('valid UTF-8 under a charset alias and a body in another encoding are accepted', async () => {
  const secret = await stack.freshRoot();
  const name = 'Nhóm ữ';
  const utf16 = Buffer.from(`{"name":"${name} 16"}`, 'utf16le');
  assert.equal(isUtf8(utf16), false);
  const decoded = await send(
    'POST',
    '/api/hr/teams',
    secret,
    utf16,
    'application/json; charset=utf-16le',
  );
  assert.equal(decoded.status, 201);
  const alias = await send(
    'POST',
    '/api/hr/teams',
    secret,
    utf8(`{"name":"${name} alias"}`),
    'application/json; charset=utf-8:1234',
  );
  assert.equal(alias.status, 201);
  const names = await teams();
  assert.ok(names.includes(`${name} 16`));
  assert.ok(names.includes(`${name} alias`));
});

// Body parser errors outside the UTF-8 check still reach the filter as unknown faults (503), as
// before; the Go runtime keeps the same answers.
test('an oversized body and an unsupported charset keep their earlier answer', async () => {
  const secret = await stack.freshRoot();
  const unavailable = { status: 503, body: { statusCode: 503, code: 'error.unavailable' } };
  for (const [body, contentType] of [
    [`{"name":"${'x'.repeat(102_400)}"}`, 'application/json'],
    ['{"name":"Team latin1"}', 'application/json; charset=latin1'],
    ['{"name":"Team unknown"}', 'application/json; charset=utf-99'],
  ] as const) {
    const { transactions, ...answer } = await send(
      'POST',
      '/api/hr/teams',
      secret,
      body,
      contentType,
    );
    assert.deepEqual(answer, unavailable, contentType);
    assert.deepEqual(transactions, [], contentType);
  }
});
