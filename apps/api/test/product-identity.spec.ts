import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalLoginEmail,
  sessionDigest,
} from '../dist/auth/services/product-identity.service.js';
import { trustedRedirectUrl } from '../dist/auth/services/product-oidc-provider.service.js';

test('login email canonicalization does not remove dots or plus tags', () => {
  assert.equal(canonicalLoginEmail('A.B+Tag@Example.COM'), 'a.b+tag@example.com');
  assert.throws(() => canonicalLoginEmail('no-email'));
  assert.throws(() => sessionDigest('not-a-session'));
});

test('OIDC redirect URIs are HTTPS, or HTTP only on a loopback host (local development)', () => {
  for (const ok of [
    'https://hr.example.test/api/auth/oidc/callback',
    'http://localhost:6368/api/auth/oidc/callback',
    'http://127.0.0.1:6368/api/auth/oidc/callback',
    'http://[::1]:6368/api/auth/oidc/callback',
  ])
    assert.equal(trustedRedirectUrl(ok).href, ok);
  for (const bad of [
    'http://hr.example.test/api/auth/oidc/callback',
    'http://localhost.example.test/api/auth/oidc/callback',
    'http://192.168.1.10:6368/api/auth/oidc/callback',
    'http://user:pw@localhost:6368/api/auth/oidc/callback',
    'http://localhost:6368/api/auth/oidc/callback?next=/',
    'http://localhost:6368/api/auth/oidc/callback#x',
    'ftp://localhost/api/auth/oidc/callback',
  ])
    assert.throws(() => trustedRedirectUrl(bad), /OIDC requires/, bad);
});
