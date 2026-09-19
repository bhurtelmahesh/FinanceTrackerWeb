import assert from 'node:assert/strict';
import test from 'node:test';

import { cloudMetaOperation, cloudRecordKey, planCloudChanges } from '../cloud-sync-plan.mjs';

const collections = ['salary', 'expenses'];
const clean = (_collection, record) => ({ id: record.id, value: record.value });

test('cloud plan writes new and changed records but skips unchanged records', () => {
  const baseline = new Map([
    [cloudRecordKey('salary', 'same'), JSON.stringify({ id: 'same', value: 1 })],
    [cloudRecordKey('salary', 'changed'), JSON.stringify({ id: 'changed', value: 1 })]
  ]);
  const { operations } = planCloudChanges(collections, {
    salary: [{ id: 'same', value: 1 }, { id: 'changed', value: 2 }],
    expenses: [{ id: 'new', value: 3 }]
  }, baseline, clean);
  assert.deepEqual(operations, [
    { type: 'set', collectionName: 'salary', recordId: 'changed', data: { id: 'changed', value: 2 } },
    { type: 'set', collectionName: 'expenses', recordId: 'new', data: { id: 'new', value: 3 } }
  ]);
});

test('cloud plan deletes records removed locally and advances its baseline', () => {
  const baseline = new Map([
    [cloudRecordKey('expenses', 'gone'), JSON.stringify({ id: 'gone', value: 1 })]
  ]);
  const { operations, nextBaseline } = planCloudChanges(collections, {}, baseline, clean);
  assert.deepEqual(operations, [
    { type: 'delete', collectionName: 'expenses', recordId: 'gone' }
  ]);
  assert.equal(nextBaseline.size, 0);
});

test('cloud metadata uses the same collection and record operation shape', () => {
  assert.deepEqual(cloudMetaOperation({ meta: { version: 3, startedAt: 'start' } }, 'now'), {
    type: 'set',
    collectionName: 'app',
    recordId: 'meta',
    data: {
      version: 3,
      startedAt: 'start',
      importedAt: '',
      sourceFile: '',
      updatedAt: 'now'
    }
  });
});
