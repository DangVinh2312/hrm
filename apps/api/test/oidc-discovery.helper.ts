// A discoverable HTTPS issuer for tests that boot the real API process (ADR 0027: Google OIDC is
// required, and the API runs OIDC discovery before it listens). Discovery and an empty JWKS only;
// sign-in flows themselves are covered in process (product-sign-in-methods) and in the browser.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

export interface DiscoveryIssuer {
  readonly issuer: string;
  /** PEM of the throwaway CA, for the API process's NODE_EXTRA_CA_CERTS. */
  readonly caFile: string;

  /**
   * Runs `work` in this process with the throwaway CA trusted as well (NODE_EXTRA_CA_CERTS is
   * read only at startup), then restores the previous default CA set.
   */
  trusted<T>(work: () => Promise<T>): Promise<T>;

  stop(): Promise<void>;
}

/** Throwaway CA + localhost certificate for one run, in a private temp directory. */
function throwawayTls(dir: string): { key: string; cert: string } {
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
    '/CN=hrm-api-test-ca',
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
    key: readFileSync(join(dir, 'leaf.key'), 'utf8'),
    cert: readFileSync(join(dir, 'leaf.pem'), 'utf8'),
  };
}

export async function startDiscoveryIssuer(): Promise<DiscoveryIssuer> {
  const dir = mkdtempSync(join(tmpdir(), 'hrm-api-issuer-'));
  try {
    const tls = throwawayTls(dir);
    let issuer = '';
    const server = createServer(tls, (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/.well-known/openid-configuration')
        return void res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
          }),
        );
      if (req.url === '/jwks') return void res.end(JSON.stringify({ keys: [] }));
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    issuer = `https://localhost:${(server.address() as AddressInfo).port}`;
    return {
      issuer,
      caFile: join(dir, 'ca.pem'),
      trusted: async (work) => {
        const previous = getCACertificates('default');
        setDefaultCACertificates([...previous, readFileSync(join(dir, 'ca.pem'), 'utf8')]);
        try {
          return await work();
        } finally {
          setDefaultCACertificates(previous);
        }
      },
      stop: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
