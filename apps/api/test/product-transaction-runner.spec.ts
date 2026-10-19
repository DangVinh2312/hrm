import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DataSource } from 'typeorm';
import { AuthorityUnavailableError } from '../dist/database/helpers/transaction-errors.helper.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';

// A pool whose first statement fails the way pg reports a session the server killed.
const brokenPool = (message: string) =>
  ({
    createQueryRunner: () => ({
      isTransactionActive: false,
      connect: () => Promise.resolve(),
      startTransaction: () => Promise.resolve(),
      query: () => Promise.reject(new Error(message)),
      release: () => Promise.resolve(),
    }),
  }) as unknown as DataSource;

for (const message of [
  'Connection terminated unexpectedly',
  'Client has encountered a connection error and is not queryable',
])
  test(`a connection error without SQLSTATE fails closed as unavailable: ${message}`, async () => {
    const runner = new ProductTransactionRunner({ data: brokenPool(message) });
    await assert.rejects(
      runner.run('read', () => Promise.resolve('unreachable')),
      (error) => error instanceof AuthorityUnavailableError,
    );
  });

test('an unrelated error is not rewritten as unavailable', async () => {
  const runner = new ProductTransactionRunner({ data: brokenPool('boom') });
  await assert.rejects(
    runner.run('read', () => Promise.resolve('unreachable')),
    (error) => !(error instanceof AuthorityUnavailableError),
  );
});
