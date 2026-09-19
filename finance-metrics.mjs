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
  // Reaching 25% below/above target is enough to reach the red/green ends of
  // the scale. Previously the denominator included the full target/actual, so
  // a visibly weak result still looked almost amber.
  const targetScale = Math.max(Math.abs(Number(target || 0)), 1);
  const distanceToEnd = 0.25;
  const performance = Math.max(-1, Math.min(1, (gap / targetScale) / distanceToEnd));
  const hue = gap < 0 ? 0 : 125;
  return { gap, performance, intensity: Math.abs(performance), hue };
}
