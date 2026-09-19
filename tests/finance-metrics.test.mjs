import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateSavings, expenseTotalForPeriod, stockPerformanceTone } from '../finance-metrics.mjs';

test('monthly savings deduct every expenditure in that month', () => {
  const expenses = [
    { year: 2026, month: 'Jan', amount: 30000 },
    { year: 2026, month: 'January', amount: 12500 },
    { year: 2026, month: 'Feb', amount: 9000 }
  ];
  const normalizeMonth = (value) => String(value).slice(0, 3);
  const total = expenseTotalForPeriod(expenses, 2026, 'Jan', normalizeMonth);
  assert.equal(total, 42500);
  assert.equal(calculateSavings(230000, total), 187500);
});

test('savings may be negative when spending exceeds take-home', () => {
  assert.equal(calculateSavings(100000, 140000), -40000);
});

test('stock performance moves from red through amber to green', () => {
  assert.equal(stockPerformanceTone(0, 100).hue, 0);
  assert.equal(stockPerformanceTone(100, 100).hue, 42);
  assert.ok(stockPerformanceTone(150, 100).hue > 42);
  assert.equal(stockPerformanceTone(0, 0, false).hue, 205);
});
