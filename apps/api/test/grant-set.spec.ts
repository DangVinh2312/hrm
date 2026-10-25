// Pure comparison of effective grant sets (ADR 0041 §2 (c)(d)): no database. A target may only be
// acted on by an IAM actor whose set contains every grant of the target; anything that cannot be
// proven (deny, rule on the user, different template/parameters) refuses, and the answer for a
// refused target is "not found" so a larger account is indistinguishable from an absent one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type GrantRuleFact,
  compareGrantSets,
  grantSetWithin,
  targetAccess,
} from '../dist/authorization/helpers/grant-set.helper.js';

const allow = (
  permission: string,
  template = 'all',
  parameters: Record<string, string | boolean> = {},
  version = 1,
): GrantRuleFact => ({
  source: 'role',
  effect: 'allow',
  permission,
  template: { key: template, version },
  parameters,
});

test('subset: every grant of the target is in the actor set; equal sets are allowed', () => {
  const actor = [allow('a.read'), allow('a.write'), allow('b.read')];
  assert.equal(compareGrantSets([allow('a.read')], actor), 'within');
  assert.equal(compareGrantSets([allow('a.read'), allow('b.read')], actor), 'within');
  assert.equal(compareGrantSets(actor, actor), 'within');
  assert.equal(compareGrantSets([...actor].reverse(), actor), 'within');
  // An account with no grant at all is within any set, even the empty one.
  assert.equal(compareGrantSets([], actor), 'within');
  assert.equal(compareGrantSets([], []), 'within');
});

test('a grant the actor does not hold makes the target larger', () => {
  const actor = [allow('a.read')];
  assert.equal(compareGrantSets([allow('a.read'), allow('a.write')], actor), 'larger');
  assert.equal(compareGrantSets([allow('x.read')], []), 'larger');
});

test('same permission with another template, version or parameters cannot be compared: refused', () => {
  const actor = [allow('a.read', 'all', { scope: 'x' })];
  assert.equal(compareGrantSets([allow('a.read', 'own', { scope: 'x' })], actor), 'incomparable');
  assert.equal(
    compareGrantSets([allow('a.read', 'all', { scope: 'x' }, 2)], actor),
    'incomparable',
  );
  assert.equal(compareGrantSets([allow('a.read', 'all', { scope: 'y' })], actor), 'incomparable');
  assert.equal(compareGrantSets([allow('a.read', 'all', {})], actor), 'incomparable');
  assert.equal(
    compareGrantSets([allow('a.read', 'all', { scope: 'x', extra: true })], actor),
    'incomparable',
  );
  assert.equal(grantSetWithin('incomparable'), false);
  // A string "true" is not the boolean true.
  assert.equal(
    compareGrantSets(
      [allow('a.read', 'all', { v: true })],
      [allow('a.read', 'all', { v: 'true' })],
    ),
    'incomparable',
  );
});

test('parameter key order and duplicate grants do not change the answer', () => {
  const actor = [allow('a.read', 'all', { p: 'x', q: true })];
  const target = [
    allow('a.read', 'all', { q: true, p: 'x' }),
    allow('a.read', 'all', { p: 'x', q: true }),
  ];
  assert.equal(compareGrantSets(target, actor), 'within');
});

test('a deny or a rule attached to the user on either side is unprovable: refused', () => {
  const ok = [allow('a.read')];
  const deny: GrantRuleFact = { ...allow('a.write'), effect: 'deny' };
  const userRule: GrantRuleFact = { ...allow('a.read'), source: 'user' };
  for (const bad of [deny, userRule]) {
    assert.equal(compareGrantSets([...ok, bad], ok), 'unprovable', 'target side');
    assert.equal(compareGrantSets(ok, [...ok, bad]), 'unprovable', 'actor side');
    assert.equal(compareGrantSets([bad], [bad]), 'unprovable', 'both sides');
    // Even an empty target is refused when the actor's own set cannot be proven.
    assert.equal(compareGrantSets([], [bad]), 'unprovable');
  }
  assert.equal(grantSetWithin('unprovable'), false);
});

test('only "within" lets the command go on', () => {
  assert.equal(grantSetWithin('within'), true);
  assert.equal(grantSetWithin('larger'), false);
});

test('Root bypasses the comparison; an IAM actor gets "not found" for anything but within', () => {
  const actor = [allow('a.read')];
  const larger = [allow('a.read'), allow('a.write')];
  const deny: GrantRuleFact[] = [{ ...allow('a.read'), effect: 'deny' }];
  // Root has no grants and no facts are needed: even unprovable targets proceed.
  assert.equal(targetAccess({ kind: 'root' }, larger), 'proceed');
  assert.equal(targetAccess({ kind: 'root' }, deny), 'proceed');
  assert.equal(targetAccess({ kind: 'iam', grants: actor }, [allow('a.read')]), 'proceed');
  assert.equal(targetAccess({ kind: 'iam', grants: actor }, actor), 'proceed');
  assert.equal(targetAccess({ kind: 'iam', grants: actor }, larger), 'not_found');
  assert.equal(targetAccess({ kind: 'iam', grants: actor }, deny), 'not_found');
  assert.equal(targetAccess({ kind: 'iam', grants: actor }, [allow('a.read', 'own')]), 'not_found');
});

/** Small deterministic PRNG so a failure reproduces from the seed. */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: "within" is exactly set inclusion over (permission, template, version, parameters)', () => {
  const universe: GrantRuleFact[] = [];
  for (const permission of ['a.read', 'a.write', 'b.read'])
    for (const template of ['all', 'own'])
      for (const parameters of [{}, { p: 'x' }, { p: 'y', q: true }] as Record<
        string,
        string | boolean
      >[])
        universe.push(allow(permission, template, parameters));

  const key = (g: GrantRuleFact) =>
    JSON.stringify([g.permission, g.template, Object.entries(g.parameters).sort()]);

  const random = mulberry32(20261025);

  const pick = () => universe.filter(() => random() < 0.35);

  for (let round = 0; round < 400; round++) {
    const actor = pick();
    const target = pick();
    const actorKeys = new Set(actor.map(key));
    const included = target.every((grant) => actorKeys.has(key(grant)));
    assert.equal(grantSetWithin(compareGrantSets(target, actor)), included, `seed round ${round}`);
    assert.equal(targetAccess({ kind: 'iam', grants: actor }, target) === 'proceed', included);
    // Reflexive, and a superset of the actor keeps the target inside.
    assert.equal(compareGrantSets(target, target), 'within');
    const bigger = [...actor, ...pick()];
    if (included) assert.equal(compareGrantSets(target, bigger), 'within', 'monotone');
    // Duplicates and order never matter.
    const shuffled = [...target, ...target].sort(() => random() - 0.5);
    assert.equal(grantSetWithin(compareGrantSets(shuffled, actor)), included);
    // One deny anywhere always refuses, whatever the sets were.
    const denied: GrantRuleFact = { ...allow('a.read'), effect: 'deny' };
    assert.equal(compareGrantSets([...target, denied], actor), 'unprovable');
    assert.equal(compareGrantSets(target, [...actor, denied]), 'unprovable');
  }
});
