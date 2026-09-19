export function expenseTotalForPeriod(expenses, year, month, normalizeMonth = (value) => value) {
  const wantedMonth = normalizeMonth(month);
  return (expenses || [])
    .filter((item) => Number(item.year) === Number(year) && normalizeMonth(item.month) === wantedMonth)
    .reduce((total, item) => total + Number(item.amount || 0), 0);
}

export function calculateSavings(takeHome, expenseTotal) {
  return Number(takeHome || 0) - Number(expenseTotal || 0);
}

export function stockPerformanceTone(actual, target, hasRecord = true) {
  if (!hasRecord) return { gap: 0, performance: 0, hue: 205 };
  const gap = Number(actual || 0) - Number(target || 0);
  const scale = Math.max(Math.abs(Number(target || 0)), Math.abs(Number(actual || 0)), 1);
  const performance = Math.max(-1, Math.min(1, gap / scale));
  const hue = Math.round(performance < 0
    ? 42 * (1 + performance)
    : 42 + performance * 78);
  return { gap, performance, hue };
}
