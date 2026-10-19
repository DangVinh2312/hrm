import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TestTls {
  readonly caFile: string;
  readonly key: string;
  readonly cert: string;
}

/** Throwaway CA + localhost certificate for one test run; never reused outside the temp dir. */
export function createTestTls(dir: string): TestTls {
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });

  run(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-subj',
    '/CN=hrm-e2e-ca',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign',
  );
  run(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'leaf.key',
    '-out',
    'leaf.csr',
    '-subj',
    '/CN=localhost',
  );
  writeFileSync(
    join(dir, 'leaf.ext'),
    'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n',
  );
  run(
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '1',
    '-out',
    'leaf.pem',
    '-extfile',
    'leaf.ext',
  );
  return {
    caFile: join(dir, 'ca.pem'),
    key: readFileSync(join(dir, 'leaf.key'), 'utf8'),
    cert: readFileSync(join(dir, 'leaf.pem'), 'utf8'),
  };
}
