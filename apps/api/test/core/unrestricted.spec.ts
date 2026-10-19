import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthorizationCore } from '../../dist/authorization/core/authorization.factory.js';
import type {
  UserAuthoritySnapshot,
  UserDecision,
  UserTrustedInput,
} from '../../dist/authorization/core/authorization.types.js';
import { createDayjsTimestampCodec } from '../../dist/authorization/values/codecs/dayjs-timestamp.codec.js';
import { createStandardValueCodecs } from '../../dist/authorization/values/codecs/standard-values.codec.js';
import {
  alice,
  core,
  declarations,
  input as userInput,
  rule,
  snapshot as userSnapshot,
  submission,
  validated,
} from './fixtures.ts';

function allowed(decision: UserDecision) {
  assert.equal(decision.effect, 'allow');
  if (decision.effect !== 'allow') throw new Error('unreachable');
  return decision.plan;
}

const record = submission('record', '1', { amount: '999.00', status: 'closed' });
const facts = {
  now: '2026-10-13T10:00:01.000000Z',
  record,
  objects: [record],
  edges: [],
  exceptions: [],
};

test('unrestricted plan: same target, revision and validity as planUser; predicate true, no obligations', () => {
  // A direct deny on approve, the approval scope and its obligation would bind planUser. The
  // policy's context requirement (assurance 2) still applies to Root (ADR 0022), so it is met.
  const plan = allowed(
    core.planUnrestricted(
      userInput({ action: 'approve', principal: { id: alice, assurance: 2 } }),
      userSnapshot({
        roles: [],
        rules: [rule('submission.approve', { kind: 'identity', identity: alice }, 'deny', 'all@1')],
      }),
    ),
  );
  assert.deepEqual(plan.predicate, { op: 'constant', value: true });
  assert.deepEqual(plan.obligations, []);
  assert.deepEqual(
    [plan.userId, plan.resource, plan.action, plan.permission, plan.revision],
    [alice, 'submission', 'approve', 'submission.approve', '7'],
  );
  assert.equal(Object.isFrozen(plan), true);
  const user = allowed(
    core.planUser(
      userInput(),
      userSnapshot({
        rules: [rule('submission.read', { kind: 'role', role: 'reviewer' }, 'allow', 'all@1')],
      }),
    ),
  );
  const unrestricted = allowed(core.planUnrestricted(userInput(), userSnapshot()));
  assert.deepEqual(
    [unrestricted.resource, unrestricted.action, unrestricted.permission, unrestricted.validUntil],
    [user.resource, user.action, user.permission, user.validUntil],
  );
  // Issued by this instance: the evaluator accepts it and every record matches.
  assert.equal(core.evaluateUser(unrestricted, facts).effect, 'allow');
});

test('unrestricted plan fails closed on target, principal, user, window, revision and provenance', () => {
  const cases: (readonly [string, UserTrustedInput, UserAuthoritySnapshot])[] = [
    ['unknown_resource', userInput({ resource: 'missing' }), userSnapshot()],
    ['unknown_action', userInput({ action: 'delete' }), userSnapshot()],
    [
      'invalid_principal',
      userInput({ principal: { id: alice.toUpperCase() as typeof alice, assurance: 1 } }),
      userSnapshot(),
    ],
    ['inactive_user', userInput(), userSnapshot({ user: { id: alice, state: 'suspended' } })],
    ['invalid_now', userInput({ now: 'not-a-time' }), userSnapshot()],
    ['invalid_validity_window', userInput({ validUntil: userInput().now }), userSnapshot()],
    ['permission_not_in_catalog', userInput(), userSnapshot({ permissions: [] })],
    ...['', '0', '-1', '07', 'x'].map(
      (revision) => ['invalid_revision', userInput(), userSnapshot({ revision })] as const,
    ),
  ];
  for (const [reason, value, authority] of cases)
    assert.deepEqual(
      core.planUnrestricted(value, authority),
      { effect: 'deny', internalReason: reason },
      reason,
    );
  const other = createAuthorizationCore({
    values: createStandardValueCodecs({ timestamp: createDayjsTimestampCodec() }),
  });
  assert.deepEqual(other.planUnrestricted(userInput(), userSnapshot()), {
    effect: 'deny',
    internalReason: 'unvalidated_declarations',
  });
  const plan = allowed(core.planUnrestricted(userInput(), userSnapshot()));
  assert.deepEqual(other.evaluateUser(plan, facts), {
    effect: 'deny',
    internalReason: 'foreign_plan',
  });
});

/** Fixture `close` action bound to a policy that requires a fresh session, like product `fresh@1`. */
function withFreshPolicy() {
  const base = declarations();
  const source = declarations({
    resources: base.resources.map((r) =>
      r.key === 'submission'
        ? {
            ...r,
            actions: {
              ...r.actions,
              close: { policy: { key: 'stepUp', version: 1 }, boundary: 'optional' as const },
            },
          }
        : r,
    ),
    policies: [
      ...base.policies,
      {
        key: 'stepUp',
        version: 1,
        contextRequirements: [{ validator: 'fresh@1', parameters: {} }],
        requiredScope: { op: 'eq', field: 'status', value: { from: 'literal', value: 'open' } },
        obligations: [],
      },
    ],
    capabilities: {
      validators: ['minimumAssurance@1', 'fresh@1'],
      obligationHandlers: ['auditBeforeCommit@1'],
    },
  });
  const plain = userSnapshot();

  const snapshot = (overrides: Partial<UserAuthoritySnapshot> = {}) =>
    userSnapshot({
      declarations: validated(source),
      permissions: [
        ...plain.permissions,
        {
          key: 'submission.close',
          resource: 'submission',
          action: 'close',
          policy: { key: 'stepUp', version: 1 },
          boundary: 'optional',
          lifecycle: 'active',
        },
      ],
      registry: {
        validators: {
          ...plain.registry.validators,
          'fresh@1': (_parameters, input) => input.context.freshAuthentication === true,
        },
        obligationHandlers: plain.registry.obligationHandlers,
      },
      ...overrides,
    });

  const close = (fresh: boolean | undefined) =>
    userInput({
      action: 'close',
      context: fresh === undefined ? {} : { freshAuthentication: fresh },
    });

  return { source, snapshot, close };
}

test('unrestricted plan enforces the action policy context requirement (ADR 0022)', () => {
  const { snapshot, close } = withFreshPolicy();
  const failed = { effect: 'deny', internalReason: 'context_requirement_failed' };
  assert.deepEqual(core.planUnrestricted(close(false), snapshot()), failed);
  assert.deepEqual(core.planUnrestricted(close(undefined), snapshot()), failed);
  const plan = allowed(core.planUnrestricted(close(true), snapshot()));
  // Still Root: the policy's required scope (status = open) and every grant stay bypassed.
  assert.deepEqual(plan.predicate, { op: 'constant', value: true });
  assert.equal(plan.permission, 'submission.close');
  // A policy without requirements allows whatever the context holds.
  const contexts: Record<string, boolean>[] = [{}, { freshAuthentication: false }];
  for (const context of contexts)
    allowed(core.planUnrestricted(userInput({ context }), snapshot()));
});

test('unrestricted plan fails closed on the policy binding and on any validator outcome but true', () => {
  const { source, snapshot, close } = withFreshPolicy();
  const permissions = snapshot().permissions;

  const rebind = (change: object) =>
    permissions.map((p) => (p.key === 'submission.close' ? { ...p, ...change } : p));

  const cases: (readonly [string, UserAuthoritySnapshot])[] = [
    // Catalog row bound to another policy (or version) than the code's action.
    [
      'policy_binding_mismatch',
      snapshot({ permissions: rebind({ policy: { key: 'baseline', version: 1 } }) }),
    ],
    [
      'policy_binding_mismatch',
      snapshot({ permissions: rebind({ policy: { key: 'stepUp', version: 2 } }) }),
    ],
    ['permission_unavailable', snapshot({ permissions: rebind({ lifecycle: 'retired' }) })],
    // Missing validator, or one that answers anything but `true` or throws.
    [
      'validator_unavailable',
      snapshot({ registry: { validators: {}, obligationHandlers: ['auditBeforeCommit@1'] } }),
    ],
    ...[() => 'unknown' as const, () => false].map(
      (validator) =>
        [
          'context_requirement_failed',
          snapshot({
            registry: {
              validators: { 'fresh@1': validator },
              obligationHandlers: ['auditBeforeCommit@1'],
            },
          }),
        ] as const,
    ),
    [
      'validator_failed',
      snapshot({
        registry: {
          validators: {
            'fresh@1': () => {
              throw new Error('fact source down');
            },
          },
          obligationHandlers: ['auditBeforeCommit@1'],
        },
      }),
    ],
  ];
  for (const [reason, authority] of cases)
    assert.deepEqual(
      core.planUnrestricted(close(true), authority),
      { effect: 'deny', internalReason: reason },
      reason,
    );
  // A retired (or absent) bound policy never validates, so no plan can be issued over it.
  const retired = {
    ...source,
    policies: source.policies.map((p) =>
      p.key === 'stepUp' ? { ...p, lifecycle: 'retired' as const } : p,
    ),
  };
  assert.equal(core.validate(retired).ok, false);
  assert.deepEqual(
    core.planUnrestricted(close(true), snapshot({ declarations: retired as never })),
    { effect: 'deny', internalReason: 'unvalidated_declarations' },
  );
});

test('unrestricted plan ignores boundary entry requirements; planUser still applies them', () => {
  const base = declarations();
  const gated = validated(
    declarations({
      boundaries: [
        {
          key: 'gate',
          version: 1,
          entries: [
            {
              permission: 'submission.read',
              contextRequirements: [
                { validator: 'minimumAssurance@1', parameters: { minimum: '3' } },
              ],
              requiredScope: { op: 'constant', value: true },
            },
          ],
        },
      ],
      capabilities: base.capabilities,
    }),
  );
  const authority = userSnapshot({
    declarations: gated,
    boundaries: [
      {
        identity: alice,
        permission: 'submission.read',
        boundary: { key: 'gate', version: 1 },
        lifecycle: 'active',
      },
    ],
  });
  assert.deepEqual(core.planUser(userInput(), authority), {
    effect: 'deny',
    internalReason: 'context_requirement_failed',
  });
  allowed(core.planUnrestricted(userInput(), authority));
});
