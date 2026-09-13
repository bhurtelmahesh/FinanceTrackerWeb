import assert from 'node:assert/strict';

import { normalizeSearchText, searchRecords, searchSnippet } from '../search.mjs';

let failures = 0;

function test(name, run) {
  try {
    run();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`✗ ${name}`);
    console.error(error);
  }
}

const sections = [{
  collection: 'overtime',
  view: 'overtime',
  label: 'Overtime',
  keywords: ['ot'],
  fields: [
    ['year', 'Year'], ['month', 'Month'], ['day', 'Day'],
    ['amount', 'Amount'], ['note', 'Note']
  ],
  records: [
    { id: 'hidden-id', year: 2026, month: 'Jan', day: 12, amount: 8500, note: 'Late shift' },
    { id: 'other-id', year: 2025, month: 'Sep', day: 4, amount: 1200, note: 'Release work' }
  ]
}];

test('normalizes case, whitespace, and full-width characters', () => {
  assert.equal(normalizeSearchText('  ＳＡＬＡＲＹ  '), 'salary');
});

test('requires a non-empty query', () => {
  assert.deepEqual(searchRecords(sections, '   '), { matches: [], total: 0 });
});

test('matches multiple terms across schema-backed fields', () => {
  const result = searchRecords(sections, '2026 late');
  assert.equal(result.total, 1);
  assert.equal(result.matches[0].record.id, 'hidden-id');
  assert.deepEqual(result.matches[0].matchingFields.map(({ key }) => key), ['year', 'note']);
});

test('matches full month names and formatted currency queries', () => {
  assert.equal(searchRecords(sections, 'January').total, 1);
  assert.equal(searchRecords(sections, '¥8,500').total, 1);
});

test('matches section keywords without searching internal properties', () => {
  assert.equal(searchRecords(sections, 'OT').total, 2);
  assert.equal(searchRecords(sections, 'hidden-id').total, 0);
});

test('reports the full count when visible results are capped', () => {
  const result = searchRecords(sections, 'overtime', 1);
  assert.equal(result.total, 2);
  assert.equal(result.matches.length, 1);
});

const helpSections = [{
  collection: 'help',
  view: 'help',
  label: 'Help',
  fields: [['heading', 'Section'], ['topic', 'Topic'], ['text', 'Help text']],
  records: [
    { id: 'help-1', heading: 'Monthly Savings', topic: 'What counts as a month so far',
      text: 'A bonus counts from the month it is paid: the year’s first bonus from June, a later one from December.' },
    { id: 'help-2', heading: 'Dashboard', topic: 'Hover and zoom',
      text: 'Scroll or pinch on a chart to zoom in on a few months.' }
  ]
}];

test('finds help prose by words in its heading, topic or text', () => {
  assert.equal(searchRecords(helpSections, 'bonus december').matches[0]?.record.id, 'help-1');
  assert.equal(searchRecords(helpSections, 'dashboard zoom').matches[0]?.record.id, 'help-2');
  assert.equal(searchRecords(helpSections, 'help').total, 2);
});

test('snips a long passage around the first term it matches', () => {
  const text = `${'Earlier words. '.repeat(10)}Take-home turns red wherever it falls below half of gross pay.${' Later words.'.repeat(10)}`;
  const snippet = searchSnippet(text, 'below half', 60);
  assert.ok(snippet.includes('below half'), snippet);
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'), snippet);
  assert.ok(snippet.length <= 62, snippet);
  assert.equal(searchSnippet('Short text.', 'short'), 'Short text.');
});

if (failures) process.exitCode = 1;
