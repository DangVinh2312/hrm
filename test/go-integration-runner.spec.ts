import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../apps/api-go/tools/test-integration.ts', import.meta.url));

const docker = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.HRM_RUNNER_LOG) {
  fs.appendFileSync(process.env.HRM_RUNNER_LOG, JSON.stringify({docker: args, secret: process.env.POSTGRES_PASSWORD ?? ''}) + '\\n');
}
if (args[0] === 'run') process.exit(Number(process.env.HRM_DOCKER_EXIT ?? 0));
if (args[0] === 'port') process.stdout.write('127.0.0.1:54321\\n');
`;

for (const [name, buildExit, testExit, args, dockerExit] of [
  ['default packages', 0, 0, [], 0],
  ['package and test filters', 0, 0, ['./internal/app', '-run', 'TestExample'], 0],
  ['test filter without packages', 0, 0, ['-run', 'TestExample'], 0],
  ['build failure', 7, 0, [], 0],
  ['test failure', 0, 9, [], 0],
  ['cluster failure', 0, 0, [], 5],
] as const) {
  test(`Go integration runner: ${name}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'hrm-runner-check-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const log = join(directory, 'calls.jsonl');
    writeFileSync(
      join(directory, 'go'),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const binary = process.env.HRM_TEST_HRMCTL;
fs.appendFileSync(process.env.HRM_RUNNER_LOG, JSON.stringify({args, cwd: process.cwd(), binary, cluster: process.env.HRM_TEST_POSTGRES_URL, exists: binary ? fs.existsSync(binary) : false}) + '\\n');
if (args[0] === 'build') {
  if (process.env.HRM_BUILD_EXIT !== '0') process.exit(Number(process.env.HRM_BUILD_EXIT));
  fs.writeFileSync(args[2], 'fixture');
} else {
  process.exit(Number(process.env.HRM_TEST_EXIT));
}

`,
      { mode: 0o700 },
    );
    writeFileSync(join(directory, 'docker'), docker, { mode: 0o700 });
    const result = spawnSync(process.execPath, [runner, ...args], {
      cwd: tmpdir(),
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        HRM_RUNNER_LOG: log,
        HRM_BUILD_EXIT: String(buildExit),
        HRM_TEST_EXIT: String(testExit),
        HRM_DOCKER_EXIT: String(dockerExit),
      },
    });
    assert.equal(result.status, buildExit || dockerExit || testExit, result.stderr);
    const every = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        return JSON.parse(line) as {
          args?: string[];
          cwd: string;
          binary?: string;
          cluster?: string;
          exists: boolean;
          docker?: string[];
          secret?: string;
        };
      });
    const calls = every.flatMap((call) => (call.args ? [{ ...call, args: call.args }] : []));
    const containers = every.flatMap((call) => (call.docker ? [call] : []));
    assert.equal(calls.length, buildExit || dockerExit ? 1 : 2);
    const started = containers.filter((call) => call.docker?.[0] === 'run');
    assert.equal(started.length, buildExit ? 0 : 1);
    const removed = every.at(-1)?.docker ?? [];
    assert.deepEqual(removed.slice(0, 3), ['rm', '--force', '--volumes']);
    const build = calls[0];
    assert.ok(build);
    assert.equal(build.args[0], 'build');
    assert.equal(build.args[3], './cmd/hrmctl');
    assert.equal(build.cwd, dirname(dirname(runner)));
    const binary = build.args[2];
    assert.ok(binary);
    assert.equal(existsSync(dirname(binary)), false, 'temporary directory must be removed');
    if (!buildExit) {
      const cluster = started[0];
      assert.ok(cluster?.docker && cluster.secret);
      assert.equal(cluster.docker.join(' ').includes(cluster.secret), false);
      assert.equal(cluster.docker[cluster.docker.indexOf('--name') + 1], removed[3]);
    }
    if (!buildExit && !dockerExit) {
      assert.equal(
        calls[1]?.cluster,
        `postgres://fixture_superuser:${started[0]?.secret ?? ''}@127.0.0.1:54321/postgres`,
      );
      const run = calls[1];
      assert.ok(run);
      assert.equal(run.binary, binary);
      assert.equal(run.exists, true);
      assert.deepEqual(run.args, [
        'test',
        '-race',
        '-tags',
        'integration',
        '-count=1',
        '-p',
        '2',
        ...(args.length && !args[0]?.startsWith('-')
          ? args
          : ['./cmd/...', './internal/...', './test/...', ...args]),
      ]);
    }
  });
}

for (const phase of ['build', 'test']) {
  test(`Go integration runner forwards termination during ${phase}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'hrm-runner-signal-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(
      join(directory, 'go'),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '${phase}') {
  process.on('SIGTERM', () => process.exit(143));
  process.stdout.write(JSON.stringify({pid: process.pid, binary: args[0] === 'build' ? args[2] : process.env.HRM_TEST_HRMCTL}));
  setInterval(() => {}, 60000);
} else {
  fs.writeFileSync(args[2], 'fixture');
}
`,
      { mode: 0o700 },
    );
    writeFileSync(join(directory, 'docker'), docker, { mode: 0o700 });
    const child = spawn(process.execPath, [runner], {
      cwd: tmpdir(),
      env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const stopped = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    const data = await new Promise<string>((resolve) => {
      child.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString()));
    });
    const active = JSON.parse(data) as { pid: number; binary: string };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      process.kill(active.pid, 'SIGKILL');
    }, 3000);
    try {
      child.kill('SIGTERM');
      const status = await stopped;
      assert.equal(status, 143);
      assert.equal(existsSync(dirname(active.binary)), false);
    } finally {
      clearTimeout(timeout);
    }
  });
}
