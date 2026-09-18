import fs from 'node:fs';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';

let testEnvironment;

before(async () => {
  testEnvironment = await initializeTestEnvironment({
    projectId: 'demo-finance-records',
    firestore: { rules: fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') }
  });
});

after(async () => {
  await testEnvironment.cleanup();
});

test('signed-out visitors cannot read financial records', async () => {
  const db = testEnvironment.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, 'users/alice/salary/jan')));
});

test('a signed-in user can write and read their own valid record', async () => {
  const db = testEnvironment.authenticatedContext('alice').firestore();
  const reference = doc(db, 'users/alice/salary/jan');
  const record = {
    id: 'jan', year: 2026, month: 'Jan', salary: 300000,
    plannedSavings: 100000, actualSavings: 120000, cumulativeCapital: 120000
  };
  await assertSucceeds(setDoc(reference, record));
  await assertSucceeds(getDoc(reference));
});

test('one user cannot access another user’s records', async () => {
  const bobDb = testEnvironment.authenticatedContext('bob').firestore();
  await assertFails(getDoc(doc(bobDb, 'users/alice/salary/jan')));
  await assertFails(setDoc(doc(bobDb, 'users/alice/daily/one'), {
    id: 'one', year: 2026, month: 'Jan', day: 1, amount: 1, status: '', note: ''
  }));
});

test('unknown fields are rejected', async () => {
  const db = testEnvironment.authenticatedContext('alice').firestore();
  await assertFails(setDoc(doc(db, 'users/alice/personalBalances/bad'), {
    id: 'bad', group: 'Test', dateOrLabel: '', amount: 1, note: '', isAdmin: true
  }));
  assert.ok(true);
});
