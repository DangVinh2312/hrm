// T6 decision rules without a database (design §6.2–§6.4.1): the full state × event × chain
// table, the chain per kind (late/early: lead only, user decision 2026-10-20) and the decision
// body (stage/actor never from the payload, reason required to reject, D08).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import {
  approvalChain,
  nextState,
} from '../dist/modules/work-request/helpers/work-request.helper.js';
import { parseCancel, parseDecision } from '../dist/modules/work-request/work-request.validator.js';
import type {
  ApprovalChain,
  RequestEvent,
  RequestKind,
  RequestState,
} from '../dist/modules/work-request/work-request.types.js';

const states: readonly RequestState[] = [
  'pending_lead',
  'pending_final',
  'approved',
  'rejected',
  'cancelled',
];
const events: readonly RequestEvent[] = [
  'lead_approve',
  'lead_reject',
  'final_approve',
  'final_reject',
  'cancel',
  'cancel_approved',
];

/** Every allowed transition; any other (state, event, chain) is invalid_transition. */
const allowed: Readonly<Record<ApprovalChain, Readonly<Record<string, RequestState>>>> = {
  'lead-final': {
    'pending_lead/lead_approve': 'pending_final',
    'pending_lead/lead_reject': 'rejected',
    'pending_lead/cancel': 'cancelled',
    'pending_final/final_approve': 'approved',
    'pending_final/final_reject': 'rejected',
    'pending_final/cancel': 'cancelled',
    'approved/cancel_approved': 'cancelled',
  },
  lead: {
    'pending_lead/lead_approve': 'approved',
    'pending_lead/lead_reject': 'rejected',
    'pending_lead/cancel': 'cancelled',
    // A lead's own late/early request skipped the lead step at submit (§6.4 (2), assumption [P]).
    'pending_final/final_approve': 'approved',
    'pending_final/final_reject': 'rejected',
    'pending_final/cancel': 'cancelled',
    'approved/cancel_approved': 'cancelled',
  },
};

test('nextState: every state × event × chain; terminal states take nothing (§6.2, §6.4.1)', () => {
  let checked = 0;
  for (const chain of ['lead', 'lead-final'] as const)
    for (const state of states)
      for (const event of events) {
        assert.equal(
          nextState(state, event, chain),
          allowed[chain][`${state}/${event}`] ?? 'invalid_transition',
          `${chain} ${state} ${event}`,
        );
        checked++;
      }
  assert.equal(checked, 60);
});

test('approval chain is fixed per kind: late/early lead only, the others lead then COO', () => {
  const chains: Record<RequestKind, ApprovalChain> = {
    'late-arrival': 'lead',
    'early-departure': 'lead',
    wfh: 'lead-final',
    'annual-leave': 'lead-final',
    'unpaid-leave': 'lead-final',
  };
  for (const [kind, chain] of Object.entries(chains))
    assert.equal(approvalChain(kind as RequestKind), chain, kind);
});

const id = '3a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d';
const key = '0b9c7a8e-2f3d-4c1b-9a8e-7d6c5b4a3f21';

const invalid = (run: () => unknown) => assert.throws(run, ProductInvalidRequest);

test('decision body: approve/reject only, reason required to reject, stage/actor/state never accepted (D08, C-18, C-25)', () => {
  assert.deepEqual(parseDecision({ expectedVersion: '1', decision: 'approve' }, id, key), {
    requestId: id,
    idempotencyKey: key,
    expectedVersion: '1',
    decision: 'approve',
    reason: null,
    acknowledgeWfhLimit: false,
  });
  assert.deepEqual(
    parseDecision({ expectedVersion: '2', decision: 'reject', reason: ' Trùng lịch ' }, id, key),
    {
      requestId: id,
      idempotencyKey: key,
      expectedVersion: '2',
      decision: 'reject',
      reason: 'Trùng lịch',
      acknowledgeWfhLimit: false,
    },
  );
  // D04: the acknowledgement is an optional boolean and nothing else.
  assert.equal(
    parseDecision({ expectedVersion: '1', decision: 'approve', acknowledgeWfhLimit: true }, id, key)
      .acknowledgeWfhLimit,
    true,
  );
  for (const acknowledgeWfhLimit of ['true', 1, null, 'yes'])
    invalid(() =>
      parseDecision({ expectedVersion: '1', decision: 'approve', acknowledgeWfhLimit }, id, key),
    );
  assert.equal(
    parseDecision({ expectedVersion: '1', decision: 'approve', reason: null }, id, key).reason,
    null,
  );
  assert.equal(
    parseDecision({ expectedVersion: '1', decision: 'approve', reason: 'Ok' }, id, key).reason,
    'Ok',
  );
  const base = { expectedVersion: '1', decision: 'approve' };
  for (const extra of ['stage', 'state', 'actorId', 'employeeId', 'version', 'kind'])
    invalid(() => parseDecision({ ...base, [extra]: 'final' }, id, key));
  // C-25 / D08: no reason, an empty or null reason, a control character.
  for (const reason of [undefined, null, '', '   ', 'a\nb'])
    invalid(() =>
      parseDecision(
        reason === undefined
          ? { expectedVersion: '1', decision: 'reject' }
          : { expectedVersion: '1', decision: 'reject', reason },
        id,
        key,
      ),
    );
  invalid(() => parseDecision({ ...base, reason: 'x'.repeat(1001) }, id, key));
  for (const decision of ['skip', 'cancel', 'APPROVE', 1, null])
    invalid(() => parseDecision({ expectedVersion: '1', decision }, id, key));
  for (const expectedVersion of [1, '0', '01', '-1', '', null])
    invalid(() => parseDecision({ expectedVersion, decision: 'approve' }, id, key));
  invalid(() => parseDecision({ decision: 'approve' }, id, key));
  invalid(() => parseDecision(null, id, key));
  invalid(() => parseDecision(base, 'not-a-uuid', key));
  invalid(() => parseDecision(base, id, key.toUpperCase()));
});

test('cancel body: expectedVersion plus an optional reason; state, actor and unknown keys never accepted (D06, B-23)', () => {
  assert.deepEqual(parseCancel({ expectedVersion: '3' }, id, key), {
    requestId: id,
    idempotencyKey: key,
    expectedVersion: '3',
    reason: null,
  });
  assert.deepEqual(parseCancel({ expectedVersion: '3', reason: ' Đổi kế hoạch ' }, id, key), {
    requestId: id,
    idempotencyKey: key,
    expectedVersion: '3',
    reason: 'Đổi kế hoạch',
  });
  assert.equal(parseCancel({ expectedVersion: '3', reason: null }, id, key).reason, null);
  for (const body of [
    {},
    { expectedVersion: 3 },
    { expectedVersion: '0' },
    { expectedVersion: '1', reason: '' },
    { expectedVersion: '1', reason: '   ' },
    { expectedVersion: '1', reason: 'x'.repeat(1001) },
    { expectedVersion: '1', reason: 5 },
    { expectedVersion: '1', state: 'cancelled' },
    { expectedVersion: '1', stage: 'cancel' },
    { expectedVersion: '1', ownerAccountId: id },
    null,
    [],
  ])
    invalid(() => parseCancel(body, id, key));
  invalid(() => parseCancel({ expectedVersion: '1' }, 'nope', key));
  invalid(() => parseCancel({ expectedVersion: '1' }, id, undefined));
  invalid(() => parseCancel({ expectedVersion: '1' }, id, 'not-a-uuid'));
});
