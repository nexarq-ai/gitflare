import assert from 'node:assert/strict';
import test from 'node:test';
import { batchSize } from '../src/batch.mjs';
import { concurrency } from '../src/concurrency.mjs';

test('each setting is within its per-agent limit', () => {
  assert.ok(batchSize >= 1 && batchSize <= 4);
  assert.ok(concurrency >= 1 && concurrency <= 4);
});

test('combined work stays within the service capacity', () => {
  assert.ok(batchSize * concurrency <= 8, `In-flight work ${batchSize * concurrency} exceeds capacity 8`);
});
