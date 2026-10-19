// Local review stack: the same disposable setup as the browser E2E (fake IdP, synthetic data),
// kept running until Ctrl+C. Not for real accounts or real Google credentials.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStack } from './stack.helper.ts';

const stack = await startStack();
const subject = 'demo-root';
const email = 'demo-root@example.test';
stack.idp.subject = subject;
stack.idp.email = email;
const file = join(tmpdir(), `hrm-dev-activation-${process.pid}.txt`);
// The activation link is a secret even here: written to a private file, never printed.
writeFileSync(file, `${stack.webOrigin}/activate#token=${await stack.bootstrapRoot(email)}\n`, {
  mode: 0o600,
  flag: 'wx',
});
console.log(
  `HRM web: ${stack.webOrigin} (self-signed certificate; the fake IdP signs in as "${subject}" with ${email})`,
);
console.log(`Activation link for the demo Root: see ${file}`);

const stop = () => {
  stack.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
