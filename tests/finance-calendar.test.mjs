import test from 'node:test';
import assert from 'node:assert/strict';
import { isBonusMonth, monthHasElapsed, monthIndex, normalizeMonth } from '../finance-calendar.mjs';

test('months are read however they were written', () => {
  assert.equal(normalizeMonth('january'), 'Jan');
  assert.equal(normalizeMonth('  MAR '), 'Mar');
  assert.equal(normalizeMonth('9'), 'Sep');
  assert.equal(monthIndex('December'), 12);
  assert.equal(monthIndex('nonsense'), 0);
});

test('a bonus is recognised in either language', () => {
  assert.ok(isBonusMonth('Bonus'));
  assert.ok(isBonusMonth('賞与'));
  assert.ok(!isBonusMonth('Jun'));
});

// The dashboard counts only months that have happened, so where a bonus falls in
// the year decides whether its take-home is in this year's savings yet.
test('the first bonus of a year is paid in June and a later one in December', () => {
  const june = { year: 2026, month: 'Bonus' };
  const december = { year: 2026, month: 'Bonus' };
  const records = [june, december];

  const inJuly = new Date('2026-07-15T00:00:00Z');
  assert.ok(monthHasElapsed(june, 2026, records, inJuly), 'June has been and gone by July');
  assert.ok(!monthHasElapsed(december, 2026, records, inJuly), 'the December bonus is still to come');

  const inDecember = new Date('2026-12-02T00:00:00Z');
  assert.ok(monthHasElapsed(december, 2026, records, inDecember));
});

test('an ordinary month is measured against the calendar', () => {
  const now = new Date('2026-09-19T00:00:00Z');
  assert.ok(monthHasElapsed({ year: 2026, month: 'Sep' }, 2026, [], now));
  assert.ok(!monthHasElapsed({ year: 2026, month: 'Oct' }, 2026, [], now));
  assert.ok(monthHasElapsed({ year: 2025, month: 'Dec' }, 2025, [], now), 'a past year is entirely behind us');
  assert.ok(!monthHasElapsed({ year: 2027, month: 'Jan' }, 2027, [], now));
});
