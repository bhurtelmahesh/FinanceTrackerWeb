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

test('stock performance uses red for losses and green for gains', () => {
  assert.equal(stockPerformanceTone(0, 100).hue, 0);
  assert.equal(stockPerformanceTone(99, 100).hue, 0, 'even a small shortfall stays red');
  assert.equal(stockPerformanceTone(100, 100).hue, 125, 'meeting target is green');
  assert.equal(stockPerformanceTone(101, 100).hue, 125, 'gains stay green');
  assert.ok(stockPerformanceTone(75, 100).intensity > stockPerformanceTone(95, 100).intensity,
    'a larger shortfall has a stronger intensity');
  assert.ok(stockPerformanceTone(125, 100).intensity > stockPerformanceTone(105, 100).intensity,
    'a larger gain has a stronger intensity');
  assert.equal(stockPerformanceTone(0, 0, false).hue, 205);
});
