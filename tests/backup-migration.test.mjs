import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateLoadedData, rehydrateArchives, withDetachedArchives } from '../backup-migration.mjs';

const collections = [
  'salary', 'monthlyDetails', 'overtime', 'stockRevenue', 'daily', 'expenses',
  'personalBalances', 'salarySheets', 'unpaidBills'
];

function emptyData() {
  const empty = { meta: { version: 1, startedAt: '', importedAt: '', sourceFile: '', updatedAt: '' } };
  collections.forEach((name) => { empty[name] = []; });
  return empty;
}

function migrate(data) {
  let counter = 0;
  return migrateLoadedData(data, {
    empty: emptyData(),
    collections,
    makeId: (name) => `${name}-generated-${counter += 1}`
  });
}

// A backup written before expenditures existed, when take-home was still called
// actualSavings and the app had not started stamping ids on every row.
const legacyBackup = {
  meta: { version: 1, startedAt: '2026-06-03T06:51:24.743Z' },
  salary: [
    { id: 'salary-1', year: 2026, month: 'Jan', salary: 412000, actualSavings: 331500, plannedSavings: 300000 },
    { year: 2026, month: 'Bonus', salary: 900000, actualSavings: 780000 }
  ],
  monthlyDetails: [{ id: 'detail-1', year: 2026, month: 'Jan', basic: 250000, received: 331500 }],
  daily: [{ id: 'daily-1', year: 2026, month: 'Jan', day: 6, amount: 1200 }],
  salarySheets: [{ id: 'sheet-1', originalName: 'jan.pdf', storedName: 'jan.pdf' }],
  _archives: { salarySheets: [{ storedName: 'jan.pdf', contentBase64: 'SGVsbG8=' }], unpaidBills: [] }
};

test('a backup written before expenditures existed still opens', () => {
  const data = migrate(structuredClone(legacyBackup));
  assert.deepEqual(data.expenses, [], 'the collection this file predates arrives empty, not undefined');
  assert.equal(data.personalBalances.length, 0);
  assert.equal(data.salary.length, 2);
  assert.equal(data.daily[0].amount, 1200);
});

test('the old actualSavings figure becomes take-home', () => {
  const data = migrate(structuredClone(legacyBackup));
  assert.equal(data.salary[0].takeHome, 331500);
  assert.equal(data.salary[1].takeHome, 780000, 'a bonus month carries its take-home too');
});

test('a take-home already on the record is left alone', () => {
  const data = migrate({ salary: [{ id: 'salary-1', year: 2026, month: 'Feb', takeHome: 288000, actualSavings: 120000 }] });
  assert.equal(data.salary[0].takeHome, 288000);
});

test('an old split expense date migrates to an ISO date', () => {
  const data = migrate({ expenses: [{ id: 'rent', year: 2026, month: 'January', day: 6, category: 'Rent', amount: 78000 }] });
  assert.equal(data.expenses[0].date, '2026-01-06');
  assert.equal(data.expenses[0].month, 'Jan');
});

test('rows saved without an id are named on the way in', () => {
  const data = migrate(structuredClone(legacyBackup));
  assert.equal(data.salary[0].id, 'salary-1');
  assert.match(data.salary[1].id, /^salary-generated-/);
});

test('anything that is not a record is dropped', () => {
  const data = migrate({ salary: [null, 'wat', ['nope'], { id: 'salary-1', year: 2026, month: 'Mar' }] });
  assert.equal(data.salary.length, 1);
  assert.equal(data.salary[0].id, 'salary-1');
});

test('archived file bytes are folded back onto their record', () => {
  const data = migrate(structuredClone(legacyBackup));
  assert.equal(data.salarySheets[0].dataUrl, 'data:application/pdf;base64,SGVsbG8=');
  assert.equal(data._archives, undefined, 'nothing is left over, so the bucket goes');
});

test('bytes with no matching record stay in the archive', () => {
  const data = rehydrateArchives({
    salarySheets: [{ id: 'sheet-1', storedName: 'jan.pdf', dataUrl: 'data:application/pdf;base64,QUJD' }],
    _archives: { salarySheets: [{ storedName: 'gone.pdf', contentBase64: 'SGVsbG8=' }], unpaidBills: [] }
  });
  assert.equal(data._archives.salarySheets.length, 1);
  assert.equal(data.salarySheets[0].dataUrl, 'data:application/pdf;base64,QUJD', 'an inline file is not overwritten');
});

test('a backup round trip keeps every record and every file', () => {
  const loaded = migrate(structuredClone(legacyBackup));
  const exported = withDetachedArchives(loaded);
  assert.equal(exported.salarySheets[0].dataUrl, undefined, 'bytes travel in _archives, not twice');
  assert.equal(exported._archives.salarySheets[0].contentBase64, 'SGVsbG8=');

  const reopened = migrate(JSON.parse(JSON.stringify(exported)));
  assert.deepEqual(reopened.salary, loaded.salary);
  assert.deepEqual(reopened.daily, loaded.daily);
  assert.equal(reopened.salarySheets[0].dataUrl, 'data:application/pdf;base64,SGVsbG8=');
});
