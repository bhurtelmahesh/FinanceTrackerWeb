import { effectiveSalaryMonth, monthIndex, normalizeMonth } from './finance-calendar.mjs';

function key(year, month) {
  return `${Number(year)}-${normalizeMonth(month)}`;
}

// Build the calculated savings ledger without turning expense-only months into
// persisted salary records. When salary and a bonus share a payment month, that
// month's expenses are deducted exactly once from the first income row.
export function buildSalaryLedger(incomeRows = [], expenses = []) {
  const expenseTotals = new Map();
  expenses.forEach((expense) => {
    const period = key(expense.year, expense.month);
    expenseTotals.set(period, (expenseTotals.get(period) || 0) + Number(expense.amount || 0));
  });

  const rows = incomeRows.map((row, order) => {
    const effectiveMonth = effectiveSalaryMonth(row, incomeRows);
    return { ...row, _effectiveMonth: effectiveMonth, _order: order };
  });
  const firstIncomeByPeriod = new Map();
  rows.forEach((row) => {
    const period = key(row.year, row._effectiveMonth);
    if (!firstIncomeByPeriod.has(period)) firstIncomeByPeriod.set(period, row._order);
  });

  const calculated = rows.map((row) => {
    const period = key(row.year, row._effectiveMonth);
    const expenseTotal = firstIncomeByPeriod.get(period) === row._order
      ? Number(expenseTotals.get(period) || 0)
      : 0;
    const takeHome = Number(row.takeHome ?? row.actualSavings ?? 0);
    const actualSavings = takeHome - expenseTotal;
    return {
      ...row,
      takeHome,
      expenseTotal,
      actualSavings,
      savingsRate: Number(row.salary || 0) ? actualSavings / Number(row.salary || 0) : 0
    };
  });

  expenseTotals.forEach((expenseTotal, period) => {
    if (firstIncomeByPeriod.has(period)) return;
    const [year, month] = period.split('-');
    calculated.push({
      id: `expense-summary-${year}-${month}`,
      year: Number(year),
      month,
      salary: 0,
      takeHome: 0,
      plannedSavings: 0,
      expenseTotal,
      actualSavings: -expenseTotal,
      savingsRate: 0,
      note: 'Expenses without salary income',
      derivedFromExpenses: true,
      _effectiveMonth: month,
      _order: Number.MAX_SAFE_INTEGER
    });
  });

  calculated.sort((a, b) =>
    Number(a.year) - Number(b.year) ||
    monthIndex(a._effectiveMonth) - monthIndex(b._effectiveMonth) ||
    a._order - b._order);

  let year = null;
  let running = 0;
  return calculated.map(({ _effectiveMonth, _order, ...row }) => {
    if (Number(row.year) !== year) {
      year = Number(row.year);
      running = 0;
    }
    running += Number(row.actualSavings || 0);
    return { ...row, cumulativeCapital: running };
  });
}
