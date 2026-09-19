import fs from 'node:fs';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';

import { forCloud } from '../cloud-fields.mjs';

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

test('a signed-in user can store an expense in their own account', async () => {
  const db = testEnvironment.authenticatedContext('alice').firestore();
  const reference = doc(db, 'users/alice/expenses/rent-jan');
  await assertSucceeds(setDoc(reference, {
    id: 'rent-jan', year: 2026, month: 'Jan', day: 6,
    category: 'Rent', amount: 78000, note: ''
  }));
  await assertSucceeds(getDoc(reference));
});

test('legacy salary notes can sync to an account', async () => {
  const db = testEnvironment.authenticatedContext('alice').firestore();
  await assertSucceeds(setDoc(doc(db, 'users/alice/salary/legacy'), {
    id: 'legacy', year: 2025, month: 'Dec', salary: 300000,
    plannedSavings: 100000, actualSavings: 120000, savingsRate: 0.4,
    cumulativeCapital: 120000, note: 'Imported from an older backup'
  }));
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

test('a record the app derives locally syncs once trimmed for the cloud', async () => {
  const db = testEnvironment.authenticatedContext('alice').firestore();
  // What the app holds: a salary row generated from Salary Details.
  const local = {
    id: 'derived', year: 2026, month: 'Feb', salary: 300000,
    plannedSavings: 100000, actualSavings: 120000, cumulativeCapital: 240000,
    derivedFromDetail: true
  };
  await assertFails(setDoc(doc(db, 'users/alice/salary/derived-raw'), local));
  const { record, dropped } = forCloud('salary', local);
  assert.deepEqual(dropped, ['derivedFromDetail']);
  await assertSucceeds(setDoc(doc(db, 'users/alice/salary/derived'), record));
});
