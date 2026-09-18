import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { cloudCollections, cloudMetaFields, cloudRecordFields, forCloud } from '../cloud-fields.mjs';

// The client trims uploads to these fields, so they must stay identical to the
// whitelists the rules enforce. Adding a field means editing both places.
const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const quoted = (text) => (text.match(/'[^']+'/g) || []).map((value) => value.slice(1, -1));

function rulesRecordFields() {
  const pattern = /match \/users\/\{userId\}\/([A-Za-z]+)\/\{recordId\}[\s\S]*?validRecord\(\[([\s\S]*?)\]\)/g;
  const found = {};
  let match;
  while ((match = pattern.exec(rules))) found[match[1]] = quoted(match[2]);
  return found;
}

test('every synced collection matches its rule whitelist', () => {
  const fromRules = rulesRecordFields();
  assert.deepEqual(Object.keys(fromRules).sort(), [...cloudCollections].sort());
  Object.entries(fromRules).forEach(([collectionName, fields]) => {
    assert.deepEqual(
      [...fields].sort(),
      [...cloudRecordFields[collectionName]].sort(),
      `${collectionName} differs between firestore.rules and cloud-fields.mjs`
    );
  });
});

test('the meta document matches its rule whitelist', () => {
  const fields = quoted(rules.match(/match \/users\/\{userId\}\/app\/meta[\s\S]*?hasOnly\(\[([\s\S]*?)\]\)/)[1]);
  assert.deepEqual([...fields].sort(), [...cloudMetaFields].sort());
});

test('a record keeps allowed fields and reports the rest', () => {
  const { record, dropped } = forCloud('salary', {
    id: 'salary-1', year: 2026, month: 'Jan', salary: 300000, derivedFromDetail: true, stray: 1
  });
  assert.deepEqual(record, { id: 'salary-1', year: 2026, month: 'Jan', salary: 300000 });
  assert.deepEqual(dropped.sort(), ['derivedFromDetail', 'stray']);
});
