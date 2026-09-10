let state = null;
let activeView = 'dashboard';
let activeChart = 'salary';
let dialogContext = null;

const schemas = {
  salary: [
    ['year', 'Year', 'number'], ['month', 'Month'], ['salary', 'Gross Income', 'number'],
    ['plannedSavings', 'Savings Goal', 'number'], ['actualSavings', 'Actual Savings', 'number'],
    ['cumulativeCapital', 'Cumulative Capital', 'number']
  ],
  monthlyDetails: [
    ['year', 'Year', 'number'], ['month', 'Month'], ['basic', 'Basic', 'number'], ['allowance', 'Allowance', 'number'],
    ['overtimePay', 'Overtime Pay', 'number'], ['transportation', 'Transportation', 'number'],
    ['grossTotal', 'Gross Total', 'number'], ['insurance', 'Health Insurance', 'number'], ['pension', 'Pension', 'number'],
    ['employmentInsurance', 'Employment Insurance', 'number'], ['residentTax', 'Residence Tax', 'number'],
    ['incomeTax', 'Income Tax', 'number'], ['totalDeduction', 'Total Deduction', 'number'], ['received', 'Net Received', 'number']
  ],
  overtime: [
    ['year', 'Year', 'number'], ['month', 'Month'], ['day', 'Day', 'number'],
    ['hours', 'OT Hours', 'number'], ['miscHours', 'Extra OT', 'number'], ['rate', 'Hourly Rate', 'number'],
    ['amount', 'Amount', 'number'], ['note', 'Note']
  ],
  stockRevenue: [
    ['year', 'Year', 'number'], ['month', 'Month'], ['targetCumulative', 'Target Cumulative', 'number'],
    ['actualCumulative', 'Actual Win Cumulative', 'number'], ['monthlyRevenue', 'Monthly Win', 'number'],
    ['surplus', 'Vs Target', 'number'], ['verdict', 'Result']
  ],
  daily: [
    ['year', 'Year', 'number'], ['month', 'Month'], ['day', 'Day', 'number'],
    ['amount', 'Amount', 'number'], ['status', 'Status'], ['note', 'Note']
  ],
  personalBalances: [
    ['group', 'Lender'], ['dateOrLabel', 'Due Date / Name'], ['amount', 'Debt Amount', 'number'], ['note', 'Note']
  ]
};

const titles = {
  dashboard: 'Dashboard',
  salary: 'Monthly Savings',
  details: 'Salary Details',
  overtime: 'Overtime',
  stocks: 'Stock Revenue',
  daily: 'Daily Records',
  balances: 'Debt Records',
  data: 'Backup & Import',
  help: 'Help'
};

const collections = ['salary', 'monthlyDetails', 'overtime', 'stockRevenue', 'daily', 'personalBalances'];
const computedFields = {
  monthlyDetails: ['grossTotal', 'totalDeduction', 'received'],
  overtime: ['amount'],
  stockRevenue: ['monthlyRevenue', 'surplus', 'verdict'],
  salary: ['savingsRate']
};
const monthOptions = [
  ['Jan', 'Jan'], ['Feb', 'Feb'], ['Mar', 'Mar'], ['Apr', 'Apr'], ['May', 'May'], ['Jun', 'Jun'],
  ['Jul', 'Jul'], ['Aug', 'Aug'], ['Sep', 'Sep'], ['Oct', 'Oct'], ['Nov', 'Nov'], ['Dec', 'Dec']
];
const fullMonthNames = {
  january: 'Jan', february: 'Feb', march: 'Mar', april: 'Apr', may: 'May', june: 'Jun', july: 'Jul',
  august: 'Aug', september: 'Sep', october: 'Oct', november: 'Nov', december: 'Dec'
};

function yen(value) {
  return new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(Number(value || 0));
}

function fileSize(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024 * 10) / 10} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function shortDate(value) {
  return value ? new Date(value).toLocaleString() : '-';
}

function isPreviewableFile(name) {
  return /\.(pdf|png|jpe?g|gif|webp|heic)$/i.test(String(name || ''));
}

function isImageFile(name) {
  return /\.(png|jpe?g|gif|webp|heic)$/i.test(String(name || ''));
}

function pct(value) {
  const n = Number(value || 0);
  return `${Math.round(n * 1000) / 10}%`;
}

function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function setSaveState(text) {
  document.getElementById('saveState').textContent = text;
}

function hasRecords() {
  return collections.some((collection) => (state[collection] || []).length > 0);
}

function searchText() {
  return (document.getElementById('globalSearch')?.value || '').trim().toLowerCase();
}

const internalFields = new Set(['id', 'derivedFromDetail', 'savingsRate', 'dataUrl', 'storedName']);

function matchesSearch(record) {
  const q = searchText();
  if (!q) return true;
  return Object.entries(record || {})
    .filter(([key]) => !internalFields.has(key))
    .some(([, value]) => String(value ?? '').toLowerCase().includes(q));
}

function filterRecords(records) {
  return (records || []).filter(matchesSearch);
}

function showSetupIfNeeded() {
  const overlay = document.getElementById('setupOverlay');
  overlay.hidden = hasRecords() || Boolean(state.meta?.startedAt);
}

let saveErrorNotified = false;

async function save() {
  setSaveState('Saving...');
  try {
    await window.financeApi.save(state);
    setSaveState('Saved');
    setTimeout(() => setSaveState('Ready'), 1200);
  } catch (error) {
    console.error(error);
    setSaveState('Save failed');
    if (!saveErrorNotified) {
      saveErrorNotified = true;
      alert(error?.message || 'Saving failed. Export a JSON backup so you do not lose records.');
    }
  }
}

function yearsFrom(records) {
  return [...new Set((records || []).map((item) => Number(item.year)).filter(Boolean))].sort((a, b) => a - b);
}

// How far past the current year the pickers reach, so a blank year can be opened
// and typed into. Raise this if you want to plan further ahead.
const futureYearSpan = 5;

// Years offered in a picker: every year that already has records, plus a
// contiguous run up to `futureYearSpan` years out. Recorded years more than 30
// years back are still listed but do not stretch the run, so one bad year value
// cannot blow the list up to thousands of options.
function selectableYears(records) {
  const now = new Date().getFullYear();
  const recorded = yearsFrom(records);
  const first = Math.min(now, ...recorded.filter((year) => year >= now - 30));
  const span = [];
  for (let year = first; year <= now + futureYearSpan; year += 1) span.push(year);
  return [...new Set([...recorded, ...span])].sort((a, b) => a - b);
}

function fillSelect(idName, values, current, allLabel) {
  const select = document.getElementById(idName);
  select.innerHTML = '';
  if (allLabel) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = allLabel;
    select.appendChild(opt);
  }
  values.forEach((value) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  });
  if (current !== undefined && current !== null) select.value = current;
}

function fillSelectPairs(idName, pairs, current, allLabel) {
  const select = document.getElementById(idName);
  select.innerHTML = '';
  if (allLabel) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = allLabel;
    select.appendChild(opt);
  }
  pairs.forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  });
  if (current !== undefined && current !== null) select.value = current;
}

function currentYear() {
  const years = yearsFrom(state.salary);
  return Number(document.getElementById('dashboardYear').value || years[years.length - 1] || new Date().getFullYear());
}

function sum(records, key) {
  return (records || []).reduce((total, item) => total + Number(item[key] || 0), 0);
}

function monthIndex(month) {
  const value = String(month || '').trim();
  const lower = value.toLowerCase();
  const fullName = fullMonthNames[lower];
  if (fullName) return monthOptions.findIndex(([key]) => key === fullName) + 1;
  const prefixedIdx = monthOptions.findIndex(([key]) => lower.startsWith(key.toLowerCase()));
  if (prefixedIdx >= 0) return prefixedIdx + 1;
  const idx = monthOptions.findIndex(([key]) => key.toLowerCase() === lower);
  if (idx >= 0) return idx + 1;
  const parsed = Number(value.replace(/[^0-9]/g, ''));
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 12 ? parsed : 0;
}

function normalizeMonth(month) {
  const lower = String(month || '').trim().toLowerCase();
  const fullName = fullMonthNames[lower];
  if (fullName) return fullName;
  const prefixed = monthOptions.find(([key]) => lower.startsWith(key.toLowerCase()));
  if (prefixed) return prefixed[0];
  const idx = monthIndex(month);
  return idx ? monthOptions[idx - 1][0] : String(month || '');
}

function isBonusMonth(month) {
  return /bonus|賞与|ボーナス/i.test(String(month || ''));
}

function sortRecordsByMonth(records) {
  const bonusCountByYear = new Map();
  const enriched = (records || []).map((record, index) => {
    const year = Number(record.year || 0);
    let sortMonth = monthIndex(record.month);
    if (isBonusMonth(record.month)) {
      const count = (bonusCountByYear.get(year) || 0) + 1;
      bonusCountByYear.set(year, count);
      sortMonth = count === 1 ? 6.5 : 12.5 + (count - 2) / 10;
    } else if (!sortMonth) {
      sortMonth = 99;
    }
    return { record, index, sortMonth };
  });
  return enriched
    .sort((a, b) =>
      Number(a.record.year || 0) - Number(b.record.year || 0) ||
      a.sortMonth - b.sortMonth ||
      a.index - b.index
    )
    .map((item) => item.record);
}

function stockVerdict(record) {
  const value = Number(record.surplus || 0);
  if (value > 0) return '✓';
  if (value < 0) return 'X';
  return '-';
}

function stockHasActual(record) {
  return Number(record.actualCumulative || 0) !== 0;
}

function normalizeStockRecord(record, previousActual = 0, isFirstActual = false) {
  const targetCumulative = Number(record.targetCumulative || 0);
  const actualCumulative = Number(record.actualCumulative || 0);
  const hasActual = stockHasActual(record);
  const monthlyRevenue = hasActual ? (isFirstActual ? 0 : actualCumulative - Number(previousActual || 0)) : 0;
  const surplus = hasActual ? actualCumulative - targetCumulative : 0;
  return {
    ...record,
    month: normalizeMonth(record.month),
    targetCumulative,
    actualCumulative,
    monthlyRevenue,
    surplus,
    verdict: surplus > 0 ? '✓' : surplus < 0 ? 'X' : '-'
  };
}

function normalizeStockYear(year) {
  const byMonth = new Map();
  (state.stockRevenue || [])
    .filter((item) => Number(item.year) === Number(year))
    .forEach((item) => byMonth.set(normalizeMonth(item.month), item));
  const records = monthOptions
    .map(([month]) => byMonth.get(month))
    .filter(Boolean);
  let previousActual = 0;
  let hasPreviousActual = false;
  const normalized = records.map((item) => {
    const isFirstActual = stockHasActual(item) && !hasPreviousActual;
    const result = normalizeStockRecord(item, previousActual, isFirstActual);
    if (stockHasActual(result)) {
      previousActual = result.actualCumulative;
      hasPreviousActual = true;
    }
    return result;
  });
  state.stockRevenue = (state.stockRevenue || []).map((item) => {
    const replacement = normalized.find((record) => record.id === item.id);
    return replacement || item;
  });
  return normalized;
}

const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// A phone cannot show 31 day columns, so it gets one month as a vertical list.
function narrowScreen() {
  return window.matchMedia('(max-width: 640px)').matches;
}

function dayState(year, month, day) {
  const monthNumber = monthIndex(month);
  const date = new Date(Number(year), monthNumber - 1, Number(day));
  if (!monthNumber || date.getMonth() !== monthNumber - 1) return { valid: false, weekend: false, label: '' };
  const weekday = date.getDay();
  return { valid: true, weekend: weekday === 0 || weekday === 6, label: weekday === 0 ? 'Sun' : weekday === 6 ? 'Sat' : '' };
}

function defaultOtRate() {
  const rates = (state.overtime || []).map((item) => Number(item.rate)).filter((rate) => rate > 0);
  return rates[rates.length - 1] || 2018;
}

function normalizeOvertimeRecord(record) {
  const hours = Number(record.hours || 0);
  const miscHours = Number(record.miscHours || 0);
  const rate = Number(record.rate || 0) || defaultOtRate();
  return {
    ...record,
    year: Number(record.year || currentYear()),
    month: normalizeMonth(record.month),
    hours,
    miscHours,
    rate,
    amount: Number(record.amount || 0) || Math.round((hours + miscHours) * rate * 100) / 100
  };
}

function isAmountEntry(raw) {
  return raw !== '' && Number.isFinite(Number(raw));
}

// The status is a marker only when it isn't the default and isn't just repeating
// the Sat/Sun label the cell already shows.
function statusMarker(record, weekendLabel) {
  const status = String(record?.status || '').trim();
  if (!status) return '';
  if (weekendLabel && status.toLowerCase() === weekendLabel.toLowerCase()) return '';
  return status;
}

function normalizeDailyRecord(record) {
  const status = String(record.status || '').trim();
  const redundant = ['realized', 'recorded'].includes(status.toLowerCase());
  return {
    ...record,
    month: normalizeMonth(record.month),
    status: redundant ? '' : status
  };
}

// The single payroll calculation for a month. Both the Overtime summary and the
// salary views read from this, so the Total on the OT page is the same Total the
// rest of the app uses.
function monthlyPayroll(detail, overtimePay) {
  const grossTotal = Number(detail.basic || 0) + Number(detail.allowance || 0) +
    overtimePay + Number(detail.transportation || 0);
  const enteredTax = Number(detail.incomeTax || 0);
  const incomeTax = enteredTax > 0 ? enteredTax : estimateMonthlyIncomeTax({ ...detail, overtimePay });
  const totalDeduction = Number(detail.insurance || 0) + Number(detail.pension || 0) +
    Number(detail.employmentInsurance || 0) + Number(detail.residentTax || 0) + incomeTax;
  return { overtimePay, grossTotal, incomeTax, totalDeduction, received: grossTotal - totalDeduction };
}

// Logged overtime is the source of truth when it exists.
function overtimePayFor(detail, year, month) {
  const logged = overtimeAmountFor(year, month);
  return logged > 0 ? logged : Number(detail.overtimePay || 0);
}

function normalizeMonthlyDetail(record) {
  const year = Number(record.year || 0);
  const month = normalizeMonth(record.month);
  const payroll = monthlyPayroll(record, overtimePayFor(record, year, month));
  return { ...record, month, ...payroll };
}

function employmentIncomeDeduction(annualSalary) {
  const income = Math.max(0, Number(annualSalary || 0));
  if (income <= 1625000) return Math.min(650000, income);
  if (income <= 1800000) return Math.max(650000, income * 0.4 - 100000);
  if (income <= 3600000) return income * 0.3 + 80000;
  if (income <= 6600000) return income * 0.2 + 440000;
  if (income <= 8500000) return income * 0.1 + 1100000;
  return 1950000;
}

function annualIncomeTaxFromTaxable(taxableIncome) {
  const taxable = Math.max(0, Math.floor(Number(taxableIncome || 0) / 1000) * 1000);
  const brackets = [
    [1950000, 0.05, 0],
    [3300000, 0.10, 97500],
    [6950000, 0.20, 427500],
    [9000000, 0.23, 636000],
    [18000000, 0.33, 1536000],
    [40000000, 0.40, 2796000],
    [Infinity, 0.45, 4796000]
  ];
  const [, rate, deduction] = brackets.find(([limit]) => taxable <= limit);
  return Math.max(0, Math.round((taxable * rate - deduction) * 1.021));
}

function estimateMonthlyIncomeTax(detail) {
  const taxableMonthlySalary = Number(detail.basic || 0) + Number(detail.allowance || 0) + Number(detail.overtimePay || 0);
  const annualSalary = taxableMonthlySalary * 12;
  const salaryIncome = Math.max(0, annualSalary - employmentIncomeDeduction(annualSalary));
  const socialDeduction = (
    Number(detail.insurance || 0) +
    Number(detail.pension || 0) +
    Number(detail.employmentInsurance || 0)
  ) * 12;
  const basicDeduction = 480000;
  return Math.round(annualIncomeTaxFromTaxable(salaryIncome - socialDeduction - basicDeduction) / 12);
}

function overtimeAmountFor(year, month) {
  const normalizedMonth = normalizeMonth(month);
  const records = (state.overtime || []).map(normalizeOvertimeRecord).filter((item) =>
    Number(item.year || year) === Number(year) && normalizeMonth(item.month) === normalizedMonth
  );
  return sum(records, 'amount');
}

function derivedSalaryRecords() {
  const existing = new Map((state.salary || []).map((item) =>
    [`${Number(item.year)}-${normalizeMonth(item.month)}`, item]
  ));
  const detailRecords = (state.monthlyDetails || []).map(normalizeMonthlyDetail);
  const derived = detailRecords.map((detail) => {
    const year = Number(detail.year || currentYear());
    const month = normalizeMonth(detail.month);
    const previous = existing.get(`${year}-${month}`) || {};
    const { grossTotal, received } = monthlyPayroll(detail, overtimePayFor(detail, year, month));
    // Savings is take-home pay. Stock movements live in Daily Records and Stock
    // Revenue and are never netted off the salary side.
    const actualSavings = received;
    return {
      ...previous,
      id: previous.id || id('salary'),
      year,
      month,
      salary: grossTotal,
      plannedSavings: Number(previous.plannedSavings || 0),
      actualSavings,
      savingsRate: grossTotal ? actualSavings / grossTotal : 0,
      cumulativeCapital: Number(previous.cumulativeCapital || 0),
      note: previous.note || '',
      derivedFromDetail: true
    };
  });
  const detailKeys = new Set(derived.map((item) => `${item.year}-${item.month}`));
  const manualOnly = (state.salary || [])
    .filter((item) => !detailKeys.has(`${Number(item.year)}-${normalizeMonth(item.month)}`))
    .map(({ derivedFromDetail, ...rest }) => rest);
  return sortRecordsByMonth([...derived, ...manualOnly]);
}

function selectedOtYear() {
  const years = yearsFrom(state.overtime);
  return Number(document.getElementById('otYearFilter')?.value || years[years.length - 1] || currentYear());
}

function selectedOtMonth() {
  return document.getElementById('otMonthFilter')?.value || monthOptions[new Date().getMonth()][0];
}

function selectedDailyYear() {
  const years = yearsFrom(state.daily);
  return Number(document.getElementById('dailyYearFilter')?.value || years[years.length - 1] || currentYear());
}

function selectedStockYear() {
  const years = yearsFrom(state.stockRevenue);
  return Number(document.getElementById('stockYearFilter')?.value || years[years.length - 1] || currentYear());
}

// The most recent month that has an actual figure — the one the Win Total reflects.
function latestStockRecordForYear(year) {
  return normalizeStockYear(year)
    .filter(stockHasActual)
    .sort((a, b) => monthIndex(a.month) - monthIndex(b.month))
    .at(-1);
}

function latestStockActualForYear(year) {
  return Number(latestStockRecordForYear(year)?.actualCumulative || 0);
}

// Whether a month has happened is a calendar question. Bonus rows are typed by
// hand, so they always count.
function monthHasElapsed(record, year) {
  const monthNumber = monthIndex(record.month);
  if (!monthNumber) return true;
  const now = new Date();
  if (Number(year) !== now.getFullYear()) return Number(year) < now.getFullYear();
  return monthNumber <= now.getMonth() + 1;
}

function renderKpis() {
  const year = currentYear();
  const salary = (state.salary || []).filter((item) => Number(item.year) === year);
  const elapsed = salary.filter((item) => monthHasElapsed(item, year));
  const monthRows = salary.filter((item) => monthIndex(item.month) > 0);
  const elapsedMonths = monthRows.filter((item) => monthHasElapsed(item, year)).length;
  const projectedMonths = monthRows.length - elapsedMonths;
  const debts = state.personalBalances;
  const actualIncome = sum(elapsed, 'salary');
  const projectedIncome = sum(salary, 'salary');
  const actualSavings = sum(elapsed, 'actualSavings');
  const projectedSavings = sum(salary, 'actualSavings');
  const stockLatest = latestStockActualForYear(year);
  const stockRecord = latestStockRecordForYear(year);
  const stockTarget = Number(stockRecord?.targetCumulative || 0);
  const debtTotal = sum(debts, 'amount');
  const lenders = new Set((debts || [])
    .map((item) => String(item.group || '').trim().toLowerCase())
    .filter(Boolean)).size;
  // Just the figure — the Help tab explains what actual and projected mean.
  const projection = (value) => projectedMonths ? `Projected ${yen(value)}` : '';
  // A tone per tile so the rail can be scanned at a glance. The value keeps its
  // own green/red meaning; the tone only says which figure you are looking at.
  const kpis = [
    ['Salary · Gross Income', yen(actualIncome), '', projection(projectedIncome), 'tone-blue', 'salary'],
    ['Salary · Take-home Saved', yen(actualSavings), actualSavings >= 0 ? 'positive' : 'negative',
      projection(projectedSavings), 'tone-green', 'salary'],
    ['Stock · Win Total', yen(stockLatest), stockLatest >= 0 ? 'positive' : 'negative',
      stockRecord ? `${stockRecord.month} target ${yen(stockTarget)}` : '', 'tone-amber', 'stocks'],
    ['Outstanding Debt', yen(debtTotal), debtTotal > 0 ? 'debt' : '',
      debts.length ? `${debts.length} record${debts.length === 1 ? '' : 's'} · ${lenders} lender${lenders === 1 ? '' : 's'}` : '',
      'tone-red', 'balances']
  ];
  document.getElementById('kpis').innerHTML = kpis.map(([label, value, cls, hint, tone, view]) =>
    `<button type="button" class="kpi ${cls} ${tone}" data-view="${view}" aria-label="${escapeHtml(label)} — open ${escapeHtml(titles[view])}"><span>${label}</span><strong>${value}</strong>${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</button>`
  ).join('');
}

function drawBarChart(canvas, labels, series) {
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(320, Math.round(rect.width || canvas.clientWidth || canvas.width));
  const h = Math.max(260, Math.round(rect.height || canvas.clientHeight || canvas.height));
  const pixelWidth = Math.round(w * dpr);
  const pixelHeight = Math.round(h * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const leftPad = 58;
  const rightPad = 30;
  const bottomPad = labels.length > 10 ? 78 : 68;
  const topPad = 42;
  const allValues = series.flatMap((s) => s.values.map((v) => Number(v || 0)));
  const maxValue = Math.max(0, ...allValues);
  const minValue = Math.min(0, ...allValues);
  const span = Math.max(1, maxValue - minValue);
  const chartBottom = h - bottomPad;
  const chartRight = w - rightPad;
  const chartHeight = chartBottom - topPad;
  const zeroY = chartBottom - ((0 - minValue) / span) * chartHeight;
  const barGroup = (chartRight - leftPad) / Math.max(labels.length, 1);
  const shortYen = (value) => {
    const n = Number(value || 0);
    const abs = Math.abs(n);
    if (abs >= 1000000) return `¥${Math.round(n / 100000) / 10}M`;
    if (abs >= 1000) return `¥${Math.round(n / 1000)}k`;
    return `¥${Math.round(n)}`;
  };
  ctx.strokeStyle = '#d8e2e7';
  ctx.beginPath();
  ctx.moveTo(leftPad, zeroY);
  ctx.lineTo(chartRight, zeroY);
  ctx.stroke();
  ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#60717b';
  const tickCount = 8;
  Array.from({ length: tickCount + 1 }, (_, index) => index / tickCount).forEach((step) => {
    const y = chartBottom - chartHeight * step;
    ctx.strokeStyle = Math.abs(y - zeroY) < 0.5 ? '#c2d0d6' : '#edf2f4';
    ctx.beginPath();
    ctx.moveTo(leftPad, y);
    ctx.lineTo(chartRight, y);
    ctx.stroke();
    ctx.fillText(shortYen(minValue + span * step), leftPad - 8, y + 4);
  });
  const barGap = 3;
  // Fill more of each slot than the old formula did, but still cap the width so a
  // very wide chart draws bars rather than slabs.
  const barWidth = Math.min(32, Math.max(5, (barGroup - 9 - barGap * (series.length - 1)) / series.length));
  const clusterWidth = barWidth * series.length + barGap * (series.length - 1);
  // Round only the end the bar grows towards, so it still sits flat on the axis.
  const fillBar = (x, y, w, h, roundTop) => {
    const r = Math.min(4, w / 2, h);
    ctx.beginPath();
    if (roundTop) {
      ctx.moveTo(x, y + h);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h);
    } else {
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + h - r);
      ctx.quadraticCurveTo(x, y + h, x + r, y + h);
      ctx.lineTo(x + w - r, y + h);
      ctx.quadraticCurveTo(x + w, y + h, x + w, y + h - r);
      ctx.lineTo(x + w, y);
    }
    ctx.closePath();
    ctx.fill();
  };
  labels.forEach((label, i) => {
    const groupCenter = leftPad + i * barGroup + barGroup / 2;
    series.forEach((s, j) => {
      const value = Number(s.values[i] || 0);
      const bh = Math.abs(value) / span * chartHeight;
      const bx = groupCenter - clusterWidth / 2 + j * (barWidth + barGap);
      const by = value >= 0 ? zeroY - bh : zeroY;
      ctx.fillStyle = s.colors ? s.colors[i] : s.color;
      fillBar(bx, by, barWidth, bh, value >= 0);
    });
    ctx.fillStyle = '#60717b';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const labelText = String(label).slice(0, 6);
    if (barGroup < 28) {
      ctx.save();
      ctx.translate(groupCenter, chartBottom + 46);
      ctx.rotate(-Math.PI / 4);
      ctx.textAlign = 'right';
      ctx.fillText(labelText, 0, 0);
      ctx.restore();
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(labelText, groupCenter, chartBottom + 34);
    }
  });
  series.forEach((s, i) => {
    const legendX = leftPad + i * 110;
    const legendColors = s.legendColors || [s.color];
    legendColors.forEach((color, colorIndex) => {
      ctx.fillStyle = color;
      ctx.fillRect(legendX + colorIndex * 14, 10, 12, 12);
    });
    ctx.fillStyle = '#263238';
    ctx.textAlign = 'left';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(s.label, legendX + legendColors.length * 14 + 6, 20);
  });
}

function renderCharts() {
  const year = currentYear();
  if (activeChart === 'stock') {
    const normalizedStock = normalizeStockYear(year);
    drawBarChart(document.getElementById('stockChart'), normalizedStock.map((item) => item.month), [
      { label: 'Target', color: '#f9c74f', values: normalizedStock.map((item) => item.targetCumulative) },
      {
        label: 'Actual',
        color: '#2e7d32',
        legendColors: ['#2e7d32', '#c33f3f'],
        values: normalizedStock.map((item) => item.actualCumulative),
        colors: normalizedStock.map((item) => !stockHasActual(item) ? '#c8d3d8' : Number(item.surplus || 0) >= 0 ? '#2e7d32' : '#c33f3f')
      }
    ]);
    return;
  }
  const salary = (state.salary || []).filter((item) => Number(item.year) === year);
  drawBarChart(document.getElementById('salaryChart'), salary.map((item) => item.month), [
    { label: 'Gross Income', color: '#256f8f', values: salary.map((item) => item.salary) },
    { label: 'Take-home', color: '#2e7d32', values: salary.map((item) => item.actualSavings) }
  ]);
}

function switchChart(chart) {
  activeChart = chart;
  ['salary', 'stock'].forEach((name) => {
    const selected = name === chart;
    const tab = document.getElementById(name === 'salary' ? 'chartTabSalary' : 'chartTabStock');
    const panel = document.getElementById(name === 'salary' ? 'chartPanelSalary' : 'chartPanelStock');
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  });
  renderCharts();
}

function renderDashboard() {
  fillSelect('dashboardYear', selectableYears(state.salary || []), currentYear());
  renderKpis();
  renderCharts();
}

function formatValue(key, value) {
  if (['salary', 'plannedSavings', 'actualSavings', 'cumulativeCapital', 'basic', 'allowance', 'overtimePay', 'transportation', 'grossTotal', 'insurance', 'pension', 'employmentInsurance', 'residentTax', 'incomeTax', 'totalDeduction', 'received', 'targetCumulative', 'actualCumulative', 'monthlyRevenue', 'surplus', 'amount', 'rate'].includes(key)) {
    return yen(value);
  }
  if (key === 'savingsRate') return pct(value);
  if (key === 'hours') return `${Math.round(Number(value || 0) * 100) / 100}`;
  return value ?? '';
}

function tableValue(key, value) {
  return escapeHtml(formatValue(key, value));
}

function cellClass(collection, key, item, type) {
  const classes = [];
  if (type === 'number') classes.push('number');
  if (collection === 'stockRevenue' && key === 'verdict') {
    const value = Number(item.surplus || item.monthlyRevenue || 0);
    classes.push(value > 0 ? 'stock-pass' : value < 0 ? 'stock-fail' : 'stock-flat');
  }
  if (collection === 'stockRevenue' && ['monthlyRevenue', 'surplus'].includes(key)) {
    const value = Number(item[key] || 0);
    classes.push(value > 0 ? 'amount-plus' : value < 0 ? 'amount-minus' : 'amount-zero');
  }
  if (collection === 'personalBalances' && key === 'amount' && Number(item.amount || 0) > 0) {
    classes.push('debt-amount');
  }
  return classes.join(' ');
}

function renderTable(containerId, collection, fields, records, options = {}) {
  const canDelete = options.canDelete || (() => true);
  const deleteHint = options.deleteHint || '';
  const rowClass = options.rowClass || (() => '');
  const rows = records.map((item) => `
    <tr class="${rowClass(item)}">
      ${fields.map(([key, , type]) => `<td class="${cellClass(collection, key, item, type)}">${tableValue(key, item[key])}</td>`).join('')}
      <td><div class="row-actions"><button data-edit="${collection}" data-id="${escapeHtml(item.id)}" aria-label="Edit record">Edit</button>${canDelete(item)
        ? `<button class="delete" data-delete="${collection}" data-id="${escapeHtml(item.id)}" aria-label="Delete record">Delete</button>`
        : `<button class="delete" type="button" disabled title="${escapeHtml(deleteHint)}" aria-label="Delete record">Delete</button>`}</div></td>
    </tr>
  `).join('');
  const html = `
    <div class="table-wrap">
      <table>
        <thead><tr>${fields.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('')}<th>Actions</th></tr></thead>
        <tbody>
          ${rows || `<tr><td colspan="${fields.length + 1}" class="empty-cell">No records found.</td></tr>`}
        </tbody>
      </table>
    </div>`;
  document.getElementById(containerId).innerHTML = html;
}

function renderSalary() {
  const salaryRecords = state.salary || [];
  const years = yearsFrom(salaryRecords);
  const selected = document.getElementById('salaryYearFilter').value || years[years.length - 1] || '';
  fillSelect('salaryYearFilter', selectableYears(salaryRecords), selected, 'All years');
  const records = sortRecordsByMonth(filterRecords(selected ? salaryRecords.filter((item) => String(item.year) === String(selected)) : salaryRecords));
  renderTable('salaryTable', 'salary', schemas.salary, records, {
    rowClass: (item) => monthHasElapsed(item, item.year) ? '' : 'row-projected',
    canDelete: (item) => !item.derivedFromDetail,
    deleteHint: 'This row is generated from Salary Details. Delete the matching salary detail instead.'
  });
}

function renderDetails() {
  const years = yearsFrom(state.monthlyDetails);
  const selected = document.getElementById('detailsYearFilter').value || years[years.length - 1] || '';
  fillSelect('detailsYearFilter', selectableYears(state.monthlyDetails), selected, 'All years');
  const records = sortRecordsByMonth(filterRecords(selected ? state.monthlyDetails.filter((item) => String(item.year) === String(selected)) : state.monthlyDetails));
  renderTable('detailsTable', 'monthlyDetails', schemas.monthlyDetails, records);
}

function renderOvertime() {
  const year = selectedOtYear();
  const month = normalizeMonth(selectedOtMonth());
  fillSelect('otYearFilter', selectableYears(state.overtime), year);
  fillSelectPairs('otMonthFilter', monthOptions, month);
  fillSelectPairs('otMonth', monthOptions, document.getElementById('otMonth')?.value || month);
  document.getElementById('otYear').value = document.getElementById('otYear').value || year;
  document.getElementById('otRate').value = document.getElementById('otRate').value || defaultOtRate();

  const recordsForMonth = state.overtime
    .filter((item) => Number(item.year) === Number(year) && normalizeMonth(item.month) === month)
    .sort((a, b) => Number(a.day || 0) - Number(b.day || 0));
  renderOtSummary(year, month, recordsForMonth);
  renderTable('overtimeTable', 'overtime', schemas.overtime, filterRecords(recordsForMonth));
}

function renderStocks() {
  const selected = selectedStockYear();
  fillSelect('stockYearFilter', selectableYears(state.stockRevenue), selected);
  const records = filterRecords(normalizeStockYear(selected));
  renderStockGrid(records, selected);
}

function renderStockGrid(records, year) {
  const byMonth = new Map(records.map((item) => [normalizeMonth(item.month), item]));
  const fields = [
    ['targetCumulative', 'Target Cumulative'],
    ['actualCumulative', 'Actual Win Cumulative']
  ];
  const calculatedFields = [
    ['monthlyRevenue', 'Monthly Win'],
    ['surplus', 'Vs Target']
  ];
  const rows = monthOptions.map(([month]) => {
    const item = byMonth.get(month) || {};
    const verdict = stockVerdict(item);
    const verdictClass = verdict === '✓' ? 'stock-pass' : verdict === 'X' ? 'stock-fail' : 'stock-flat';
    return `
      <tr>
        <th class="stock-month-cell">${escapeHtml(month)}</th>
        ${fields.map(([key]) => `
          <td>
            <input class="grid-input stock-cell-input" type="number" step="any"
              aria-label="${escapeHtml(month)} ${escapeHtml(key === 'targetCumulative' ? 'target cumulative' : 'actual win cumulative')}"
              data-stock-year="${year}" data-stock-month="${month}" data-stock-field="${key}"
              value="${item[key] ?? ''}">
          </td>
        `).join('')}
        ${calculatedFields.map(([key]) => {
          const value = Number(item[key] || 0);
          const amountClass = value > 0 ? 'amount-plus' : value < 0 ? 'amount-minus' : 'amount-zero';
          return `<td class="number calculated-cell ${amountClass}">${yen(value)}</td>`;
        }).join('')}
        <td class="${verdictClass}">${verdict}</td>
      </tr>
    `;
  }).join('');
  document.getElementById('stockTable').innerHTML = `
    <div class="stock-grid-wrap">
      <table class="stock-grid">
        <thead>
          <tr><th>Month</th>${[...fields, ...calculatedFields].map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('')}<th>Result</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function defaultDailyMonth(year) {
  const withRecords = (state.daily || [])
    .filter((item) => Number(item.year) === Number(year) && Number(item.amount) !== 0)
    .map((item) => monthIndex(item.month))
    .filter(Boolean)
    .sort((a, b) => a - b);
  const index = withRecords.length ? withRecords[withRecords.length - 1] : new Date().getMonth() + 1;
  return monthOptions[Math.min(index, 12) - 1][0];
}

function renderDaily() {
  const year = selectedDailyYear();
  fillSelect('dailyYearFilter', selectableYears(state.daily), year);
  let selected = document.getElementById('dailyMonthFilter').value || '';
  // The list shows one month at a time, so "All months" needs resolving.
  if (narrowScreen() && !selected) selected = defaultDailyMonth(year);
  fillSelectPairs('dailyMonthFilter', monthOptions, selected, 'All months');
  const recordsForYear = state.daily.filter((item) => Number(item.year) === Number(year));
  const records = filterRecords(selected ? recordsForYear.filter((item) => item.month === selected) : recordsForYear);
  renderDailyGrid(records, selected, year);
}

function renderDailyList(records, month, year) {
  const days = Array.from({ length: 31 }, (_, index) => index + 1);
  let monthTotal = 0;
  const rows = days.map((day) => {
    const stateForDay = dayState(year, month, day);
    if (!stateForDay.valid) return '';
    const dayRecords = records.filter((item) => normalizeMonth(item.month) === month && Number(item.day) === day);
    const amount = sum(dayRecords, 'amount');
    monthTotal += amount;
    const status = amount === 0 ? String(dayRecords[0]?.status || '').trim() : '';
    const marker = amount === 0 ? statusMarker(dayRecords[0], stateForDay.label) : '';
    const cellValue = amount !== 0 ? String(amount) : marker || (status ? '' : (dayRecords.length ? '0' : ''));
    const cls = marker ? 'daily-status' : amount > 0 ? 'daily-plus' : amount < 0 ? 'daily-minus' : 'daily-zero';
    const weekday = weekdayNames[new Date(Number(year), monthIndex(month) - 1, day).getDay()];
    return `
      <tr class="${stateForDay.weekend ? 'weekend-row' : ''}">
        <th scope="row"><b>${day}</b><span>${weekday}</span></th>
        <td class="daily-day-cell ${stateForDay.weekend ? 'weekend' : ''} ${dayRecords.length ? 'has-records' : ''}">
          <input class="grid-input daily-cell-input ${cls}" type="text"
            aria-label="${escapeHtml(month)} ${day} amount or status"
            placeholder="${escapeHtml(stateForDay.label)}"
            data-daily-year="${year}" data-daily-month="${month}" data-daily-day="${day}"
            value="${escapeHtml(cellValue)}">
        </td>
      </tr>`;
  }).join('');
  const totalClass = monthTotal > 0 ? 'daily-plus' : monthTotal < 0 ? 'daily-minus' : 'daily-zero';
  document.getElementById('dailyTable').innerHTML = `
    <div class="daily-list-wrap">
      <table class="daily-list">
        <caption>${escapeHtml(month)} ${year}</caption>
        <colgroup><col class="daily-list-day"><col></colgroup>
        <thead><tr><th>Day</th><th>Amount or status</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th scope="row">Month total</th><td class="${totalClass}">${records.length ? yen(monthTotal) : '-'}</td></tr></tfoot>
      </table>
    </div>`;
}

function renderDailyGrid(records, selectedMonth, year) {
  if (narrowScreen()) {
    return renderDailyList(records, selectedMonth || defaultDailyMonth(year), year);
  }
  const months = selectedMonth
    ? [selectedMonth]
    : monthOptions.map(([month]) => month);
  const days = Array.from({ length: 31 }, (_, index) => index + 1);
  const monthTotals = [];
  const monthRows = months.map((month) => {
    let monthTotal = 0;
    const cells = days.map((day) => {
      const stateForDay = dayState(year, month, day);
      const dayRecords = records
        .filter((item) => normalizeMonth(item.month) === month && Number(item.day) === day)
        .sort((a, b) => Number(a.year || 0) - Number(b.year || 0));
      const amount = sum(dayRecords, 'amount');
      monthTotal += amount;
      if (!stateForDay.valid) {
        return `<td class="daily-day-cell invalid-day" aria-label="${escapeHtml(month)} ${day} is not a valid day"></td>`;
      }
      const status = amount === 0 ? String(dayRecords[0]?.status || '').trim() : '';
      // Blank when the status just repeats the Sat/Sun label the cell already shows.
      const marker = amount === 0 ? statusMarker(dayRecords[0], stateForDay.label) : '';
      const cellValue = amount !== 0 ? String(amount)
        : marker || (status ? '' : (dayRecords.length ? '0' : ''));
      const cls = marker ? 'daily-status' : amount > 0 ? 'daily-plus' : amount < 0 ? 'daily-minus' : 'daily-zero';
      return `
        <td class="daily-day-cell ${stateForDay.weekend ? 'weekend' : ''} ${dayRecords.length ? 'has-records' : ''}">
          <input class="grid-input daily-cell-input ${cls}" type="text"
            aria-label="${escapeHtml(month)} ${day} amount or status"
            placeholder="${escapeHtml(stateForDay.label)}"
            data-daily-year="${year}" data-daily-month="${month}" data-daily-day="${day}"
            value="${escapeHtml(cellValue)}">
        </td>
      `;
    }).join('');
    monthTotals.push(monthTotal);
    const totalClass = monthTotal > 0 ? 'daily-plus' : monthTotal < 0 ? 'daily-minus' : 'daily-zero';
    const monthHasRecords = records.some((item) => normalizeMonth(item.month) === month);
    const monthLabel = monthHasRecords ? yen(monthTotal) : '-';
    return `<tr><th class="daily-month-cell">${escapeHtml(month)}<span class="inline-total ${totalClass}">${monthLabel}</span></th>${cells}<td class="daily-total-cell ${totalClass}">${monthLabel}</td></tr>`;
  }).join('');
  const annualTotal = monthTotals.reduce((total, value) => total + value, 0);
  const annualClass = annualTotal > 0 ? 'daily-plus' : annualTotal < 0 ? 'daily-minus' : 'daily-zero';
  document.getElementById('dailyTable').innerHTML = `
    <div class="daily-grid-wrap">
      <table class="daily-grid">
        <colgroup>
          <col class="daily-month-col">
          ${days.map(() => '<col class="daily-day-col">').join('')}
          <col class="daily-total-col">
        </colgroup>
        <thead>
          <tr><th class="daily-corner-head">Month / Day</th>${days.map((day) => `<th>${day}</th>`).join('')}<th class="daily-total-head">Monthly Total</th></tr>
        </thead>
        <tbody>${monthRows}</tbody>
        <tfoot>
          <tr>
            <th class="daily-annual-label">Annual Total<span class="inline-total ${annualClass}">${annualTotal ? yen(annualTotal) : '-'}</span></th>
            <td colspan="${days.length}"></td>
            <td class="daily-annual-total ${annualClass}">${annualTotal ? yen(annualTotal) : '-'}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}

function renderBalances() {
  renderTable('balanceTable', 'personalBalances', schemas.personalBalances, filterRecords(state.personalBalances));
}

function renderOtSummary(year, month, records) {
  const detail = (state.monthlyDetails || []).find((item) =>
    Number(item.year) === Number(year) && normalizeMonth(item.month) === normalizeMonth(month)
  ) || {};
  const otHours = sum(records, 'hours');
  const miscHours = sum(records, 'miscHours');
  const totalHours = otHours + miscHours;
  const rate = records.find((item) => Number(item.rate) > 0)?.rate || defaultOtRate();
  const otAmount = sum(records, 'amount') || Math.round(totalHours * rate * 100) / 100;
  const basic = Number(detail.basic || 0);
  const allowance = Number(detail.allowance || 0);
  const transportation = Number(detail.transportation || 0);
  const insurance = Number(detail.insurance || 0);
  const pension = Number(detail.pension || 0);
  const employmentInsurance = Number(detail.employmentInsurance || 0);
  const residentTax = Number(detail.residentTax || 0);
  const { grossTotal, incomeTax, totalDeduction: deductionTotal, received } =
    monthlyPayroll(detail, otAmount);
  document.getElementById('otSummaryTitle').textContent = `${month} ${year} OT Summary`;
  document.getElementById('otSummary').innerHTML = `
    <div class="ot-sheet">
      <div class="ot-list">
        <div class="ot-line"><span>OT</span><strong>${totalHours.toFixed(2)}</strong></div>
        <div class="ot-subline"><span>Daily OT</span><strong>${otHours.toFixed(2)}</strong></div>
        <div class="ot-subline"><span>Extra OT</span><strong>${miscHours.toFixed(2)}</strong></div>
        <div class="ot-total-line"><span>Total</span><strong>${totalHours.toFixed(2)}</strong><b>${yen(otAmount)}</b></div>
        <div class="ot-received"><span>Amount received</span><strong>${yen(received)}</strong></div>
      </div>
      <div class="ot-payroll">
        <div><span>Hourly Rate</span><strong>${yen(rate)}</strong></div>
        <div><span>Basic</span><strong>${yen(basic)}</strong></div>
        <div><span>Allowance</span><strong>${yen(allowance)}</strong></div>
        <div><span>Overtime</span><strong>${yen(otAmount)}</strong></div>
        <div><span>Transportation</span><strong>${yen(transportation)}</strong></div>
        <hr>
        <div class="total"><span>Total</span><strong>${yen(grossTotal)}</strong></div>
        <div><span>Insurance</span><strong>${yen(insurance)}</strong></div>
        <div><span>Pension</span><strong>${yen(pension)}</strong></div>
        <div><span>Employment Insurance</span><strong>${yen(employmentInsurance)}</strong></div>
        <hr>
        <div><span>Residence Tax</span><strong>${yen(residentTax)}</strong></div>
        <div><span>Income Tax</span><strong>${yen(incomeTax)}</strong></div>
        <div class="total"><span>Total Deduction</span><strong>${yen(deductionTotal)}</strong></div>
      </div>
    </div>
  `;
}

function renderData() {
  document.getElementById('dataPathText').textContent = state.meta?.dataPath || 'Browser private storage';
  document.getElementById('startedAtText').textContent = state.meta?.startedAt ? new Date(state.meta.startedAt).toLocaleString() : '-';
  document.getElementById('updatedAtText').textContent = state.meta?.updatedAt ? new Date(state.meta.updatedAt).toLocaleString() : '-';
  document.getElementById('sourceFileText').textContent = state.meta?.sourceFile || 'None';
  renderSalarySheets();
}

function fileCount(list) {
  return `${list.length} ${list.length === 1 ? 'file' : 'files'}`;
}

function renderSalarySheets() {
  const sheets = state.salarySheets || [];
  document.getElementById('salarySheetCount').textContent = fileCount(sheets);
  document.getElementById('salarySheetList').innerHTML = sheets.length ? sheets
    .slice()
    .sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')))
    .map((sheet) => `
      <div class="salary-sheet-item">
        <div>
          <strong>${escapeHtml(sheet.originalName)}</strong>
          <span>Saved ${escapeHtml(shortDate(sheet.savedAt))} · ${escapeHtml(fileSize(sheet.size))}</span>
        </div>
        <div class="row-actions">
          ${isPreviewableFile(sheet.originalName) ? `<button data-preview-salary-sheet="${escapeHtml(sheet.storedName)}" data-preview-title="${escapeHtml(sheet.originalName)}">Preview</button>` : ''}
          <button data-open-salary-sheet="${escapeHtml(sheet.storedName)}">Open</button>
          <button class="delete" data-delete-salary-sheet="${escapeHtml(sheet.id)}">Delete</button>
        </div>
      </div>
    `).join('') : '<p class="muted">No salary sheets saved yet.</p>';
}

function renderUnpaidBills() {
  const bills = state.unpaidBills || [];
  document.getElementById('unpaidBillCount').textContent = fileCount(bills);
  document.getElementById('unpaidBillList').innerHTML = bills.length ? bills
    .slice()
    .sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')))
    .map((bill) => `
      <div class="salary-sheet-item">
        <div>
          <strong>${escapeHtml(bill.title)}</strong>
          <span>${escapeHtml(bill.originalName)} · Saved ${escapeHtml(shortDate(bill.savedAt))} · ${escapeHtml(fileSize(bill.size))}</span>
        </div>
        <div class="row-actions">
          ${isPreviewableFile(bill.originalName) ? `<button data-preview-unpaid-bill="${escapeHtml(bill.storedName)}" data-preview-title="${escapeHtml(bill.title)}">Preview</button>` : ''}
          <button data-open-unpaid-bill="${escapeHtml(bill.storedName)}">Open</button>
          <button class="delete" data-delete-unpaid-bill="${escapeHtml(bill.id)}">Delete</button>
        </div>
      </div>
    `).join('') : '<p class="muted">No unpaid bill documents saved yet.</p>';
}

// Tidying records is a state concern, not a render concern. The views used to
// normalize as a side effect, so whichever view went unrendered left records stale.
function normalizeState() {
  state.overtime = (state.overtime || []).map(normalizeOvertimeRecord);
  state.daily = (state.daily || []).map(normalizeDailyRecord);
  state.monthlyDetails = (state.monthlyDetails || []).map(normalizeMonthlyDetail);
  state.salary = derivedSalaryRecords();
}

const viewRenderers = {
  dashboard: renderDashboard,
  salary: renderSalary,
  details: renderDetails,
  overtime: renderOvertime,
  stocks: renderStocks,
  daily: renderDaily,
  balances: () => {
    renderBalances();
    renderUnpaidBills();
  },
  data: renderData,
  // Static documentation; nothing to rebuild.
  help: () => {}
};

const scrollableRegions = ['.daily-grid-wrap', '.stock-grid-wrap', '.table-wrap'];

function render() {
  normalizeState();
  showSetupIfNeeded();
  const view = document.getElementById(activeView);
  const saved = scrollableRegions.map((selector) => {
    const el = view && view.querySelector(selector);
    return el ? { selector, left: el.scrollLeft, top: el.scrollTop } : null;
  }).filter(Boolean);
  const viewTop = view ? view.scrollTop : 0;
  (viewRenderers[activeView] || renderDashboard)();
  saved.forEach(({ selector, left, top }) => {
    const el = view && view.querySelector(selector);
    if (!el) return;
    el.scrollLeft = left;
    el.scrollTop = top;
  });
  if (view) view.scrollTop = viewTop;
}

// Rebuilding the grid destroys the element that was about to receive focus, so
// re-find its replacement by the coordinates in its data attributes.
function gridCellSelector(input) {
  const data = input.dataset;
  if (data.dailyYear) {
    return `input[data-daily-year="${data.dailyYear}"][data-daily-month="${data.dailyMonth}"][data-daily-day="${data.dailyDay}"]`;
  }
  if (data.stockYear) {
    return `input[data-stock-year="${data.stockYear}"][data-stock-month="${data.stockMonth}"][data-stock-field="${data.stockField}"]`;
  }
  return '';
}

function switchView(view) {
  activeView = view;
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === view));
  document.querySelectorAll('#nav button').forEach((btn) => {
    const selected = btn.dataset.view === view;
    btn.classList.toggle('active', selected);
    if (selected) {
      btn.setAttribute('aria-current', 'page');
    } else {
      btn.removeAttribute('aria-current');
    }
  });
  document.getElementById('viewTitle').textContent = titles[view];
  render();
}

function openEditor(collection, record) {
  dialogContext = { collection, id: record && record.id };
  document.getElementById('dialogTitle').textContent = record && record.id ? 'Edit record' : 'Add record';
  const fields = schemas[collection];
  const computed = new Set(computedFields[collection] || []);
  document.getElementById('dialogFields').innerHTML = fields.map(([key, label, type]) => {
    const isComputed = computed.has(key);
    return `
    <div class="field ${key === 'note' ? 'full' : ''}">
      <label for="field-${key}">${escapeHtml(label)}${isComputed ? ' <span class="field-computed">calculated</span>' : ''}</label>
      <input id="field-${key}" name="${key}" type="${type === 'number' ? 'number' : 'text'}" step="any"${isComputed ? ' readonly tabindex="-1" title="Calculated from the other fields when you save."' : ''} value="${record && record[key] !== undefined ? escapeHtml(record[key]) : ''}">
    </div>
  `;
  }).join('');
  document.getElementById('recordDialog').showModal();
}

function saveDialogRecord() {
  const { collection, id: recordId } = dialogContext;
  const fields = schemas[collection];
  const values = { id: recordId || id(collection) };
  fields.forEach(([key, , type]) => {
    const value = document.getElementById(`field-${key}`).value;
    values[key] = type === 'number' ? Number(value || 0) : value;
  });
  if (collection === 'overtime') {
    values.month = normalizeMonth(values.month);
    values.amount = Math.round((Number(values.hours || 0) + Number(values.miscHours || 0)) * Number(values.rate || 0) * 100) / 100;
  }
  if (collection === 'monthlyDetails') {
    values.month = normalizeMonth(values.month);
    const calculatedOtPay = overtimeAmountFor(values.year, values.month);
    if (calculatedOtPay > 0) values.overtimePay = calculatedOtPay;
    Object.assign(values, monthlyPayroll(values, Number(values.overtimePay || 0)));
  }
  if (recordId) {
    state[collection] = state[collection].map((item) => item.id === recordId ? values : item);
  } else {
    state[collection].push(values);
  }
  render();
  save();
}

function deleteRecord(collection, recordId) {
  if (!confirm('Delete this record?')) return;
  state[collection] = state[collection].filter((item) => item.id !== recordId);
  render();
  save();
}

async function importExcelWithConfirmation() {
  if (hasRecords() && !confirm('Importing a backup will replace the current browser records. Continue?')) return;
  try {
    const imported = await window.financeApi.importExcel();
    if (imported) {
      state = imported;
      state.salarySheets = state.salarySheets || [];
      state.unpaidBills = state.unpaidBills || [];
      render();
      setSaveState('Imported');
    }
  } catch (error) {
    console.error(error);
    setSaveState('Import failed');
    alert(error?.message || 'Import failed. Please choose a valid Finance Tracker JSON backup.');
  }
}

function addQuickOtEntry(event) {
  event.preventDefault();
  const hours = Number(document.getElementById('otHours').value || 0);
  const miscHours = Number(document.getElementById('otMiscHours').value || 0);
  const rate = Number(document.getElementById('otRate').value || 0);
  const record = {
    id: id('ot'),
    year: Number(document.getElementById('otYear').value || currentYear()),
    month: normalizeMonth(document.getElementById('otMonth').value),
    day: Number(document.getElementById('otDay').value || 0),
    hours,
    miscHours,
    rate,
    amount: Math.round((hours + miscHours) * rate * 100) / 100,
    note: document.getElementById('otNote').value || ''
  };
  state.overtime.push(record);
  document.getElementById('otYearFilter').value = record.year;
  document.getElementById('otMonthFilter').value = record.month;
  document.getElementById('otDay').value = '';
  document.getElementById('otHours').value = '';
  document.getElementById('otMiscHours').value = '0';
  document.getElementById('otNote').value = '';
  render();
  save();
}

function updateAmountInputClass(input) {
  const raw = String(input.value || '').trim();
  const numeric = isAmountEntry(raw);
  const value = numeric ? Number(raw) : 0;
  input.classList.toggle('daily-status', raw !== '' && !numeric);
  input.classList.toggle('daily-plus', numeric && value > 0);
  input.classList.toggle('daily-minus', numeric && value < 0);
  input.classList.toggle('daily-zero', numeric && value === 0);
}

function saveDailyCell(input) {
  const year = Number(input.dataset.dailyYear);
  const month = normalizeMonth(input.dataset.dailyMonth);
  const day = Number(input.dataset.dailyDay);
  const raw = String(input.value || '').trim();
  const matchesDay = (item) =>
    Number(item.year) === year && normalizeMonth(item.month) === month && Number(item.day) === day;
  const existing = (state.daily || []).filter(matchesDay);
  state.daily = (state.daily || []).filter((item) => !matchesDay(item));
  if (raw !== '') {
    const previous = existing[0] || {};
    const notes = existing.map((item) => String(item.note || '').trim()).filter(Boolean);
    const numeric = isAmountEntry(raw);
    state.daily.push({
      ...previous,
      id: previous.id || id('daily'),
      year,
      month,
      day,
      amount: numeric ? Number(raw) : 0,
      status: numeric ? '' : raw,
      note: notes.join(' / ')
    });
  }
  render();
  save();
}

function saveStockCell(input) {
  const year = Number(input.dataset.stockYear);
  const month = normalizeMonth(input.dataset.stockMonth);
  const field = input.dataset.stockField;
  const raw = String(input.value || '').trim();
  let record = (state.stockRevenue || []).find((item) =>
    Number(item.year) === year && normalizeMonth(item.month) === month
  );
  if (!record) {
    record = {
      id: id('stock'),
      year,
      month,
      targetCumulative: 0,
      actualCumulative: 0,
      monthlyRevenue: 0,
      surplus: 0,
      verdict: '-'
    };
    state.stockRevenue.push(record);
  }
  record[field] = raw === '' ? 0 : Number(raw || 0);
  record.verdict = stockVerdict(record);
  const hasValues = ['targetCumulative', 'actualCumulative']
    .some((key) => Number(record[key] || 0) !== 0);
  if (!hasValues) {
    state.stockRevenue = state.stockRevenue.filter((item) => item.id !== record.id);
  }
  render();
  save();
}

function editCurrentOtSalaryDetail() {
  const year = selectedOtYear();
  const month = normalizeMonth(selectedOtMonth());
  const record = (state.monthlyDetails || []).find((item) =>
    Number(item.year) === Number(year) && normalizeMonth(item.month) === month
  );
  openEditor('monthlyDetails', record || {
    year,
    month,
    basic: 0,
    allowance: 0,
    overtimePay: 0,
    transportation: 0,
    grossTotal: 0,
    insurance: 0,
    pension: 0,
    employmentInsurance: 0,
    residentTax: 0,
    incomeTax: 0,
    totalDeduction: 0,
    received: 0
  });
}

async function buildDemoData() {
  try {
    const response = await fetch('./public-seed.json');
    if (response.ok) {
      const seed = normalizeLoadedData(await response.json());
      seed.meta = {
        ...seed.meta,
        sourceFile: 'Sample finance records',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        dataPath: 'Browser private storage'
      };
      seed.personalBalances = [];
      seed.salarySheets = [];
      seed.unpaidBills = [];
      return seed;
    }
  } catch (error) {
    // Fall back to generated sample data when the static seed file is unavailable.
  }
  const year = 2026;
  const monthlyDetails = monthOptions.map(([month], index) => {
    const basic = 240000 + (index % 3) * 5000;
    const allowance = 25000;
    const overtimePay = index < 6 ? [12000, 18000, 0, 22000, 15000, 28000][index] : 0;
    const transportation = 12000;
    const insurance = 15000;
    const pension = 27000;
    const employmentInsurance = 1600;
    const residentTax = index < 5 ? 11000 : 12500;
    const draft = { basic, allowance, overtimePay, insurance, pension, employmentInsurance };
    const incomeTax = estimateMonthlyIncomeTax(draft);
    const totalDeduction = insurance + pension + employmentInsurance + residentTax + incomeTax;
    const grossTotal = basic + allowance + overtimePay + transportation;
    return {
      id: id('detail'),
      year,
      month,
      basic,
      allowance,
      overtimePay,
      transportation,
      grossTotal,
      insurance,
      pension,
      employmentInsurance,
      residentTax,
      incomeTax,
      totalDeduction,
      received: grossTotal - totalDeduction
    };
  });
  const daily = [
    ['Jan', 5, 4200], ['Jan', 12, 7800], ['Jan', 19, -1500],
    ['Feb', 3, 5600], ['Feb', 14, 12800], ['Mar', 8, 9100],
    ['Apr', 2, 4500], ['Apr', 16, -900], ['May', 7, 6200],
    ['May', 21, 14500], ['Jun', 4, 8300], ['Jun', 18, -2200]
  ].map(([month, day, amount]) => ({
    id: id('daily'),
    year,
    month,
    day,
    amount,
    status: '',
    note: ''
  }));
  const overtime = [
    ['Jan', 10, 2, 0, 2100], ['Feb', 12, 3, 1, 2100], ['Apr', 9, 4, 0, 2100],
    ['May', 20, 2.5, 0.5, 2100], ['Jun', 11, 5, 1, 2100]
  ].map(([month, day, hours, miscHours, rate]) => ({
    id: id('ot'),
    year,
    month,
    day,
    hours,
    miscHours,
    rate,
    amount: Math.round((hours + miscHours) * rate * 100) / 100,
    note: ''
  }));
  const salary = monthlyDetails.map((detail, index) => {
    const dailyTotal = sum(daily.filter((item) => item.month === detail.month), 'amount');
    const actualSavings = detail.received - Math.max(0, dailyTotal);
    return {
      id: id('salary'),
      year,
      month: detail.month,
      salary: detail.received,
      plannedSavings: 120000,
      actualSavings,
      cumulativeCapital: actualSavings + index * 115000
    };
  });
  const stockRevenue = monthOptions.map(([month], index) => {
    const targetCumulative = [300000, 650000, 900000, 1200000, 1500000, 1800000, 2200000, 2600000, 3000000, 3500000, 4200000, 5000000][index];
    const actualValues = [350000, 720000, 680000, 1150000, 1620000, 1510000, 0, 0, 0, 0, 0, 0];
    const actualCumulative = actualValues[index];
    const previousActual = index > 0 ? actualValues.slice(0, index).filter(Boolean).at(-1) || 0 : 0;
    const monthlyRevenue = actualCumulative ? actualCumulative - previousActual : 0;
    const surplus = actualCumulative ? actualCumulative - targetCumulative : 0;
    return {
      id: id('stock'),
      year,
      month,
      targetCumulative,
      actualCumulative,
      monthlyRevenue,
      surplus,
      verdict: surplus > 0 ? '✓' : surplus < 0 ? 'X' : '-'
    };
  });
  return {
    meta: {
      version: 1,
      sourceFile: 'Demo data',
      importedAt: '',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dataPath: state.meta?.dataPath || 'Browser private storage'
    },
    salary,
    monthlyDetails,
    overtime,
    stockRevenue,
    daily,
    personalBalances: [
      { id: id('balance'), group: 'Utility bill', dateOrLabel: '2026-07-31', amount: 18500, note: 'Demo unpaid bill' },
      { id: id('balance'), group: 'Credit card', dateOrLabel: '2026-08-10', amount: 42000, note: 'Demo balance' }
    ],
    salarySheets: [],
    unpaidBills: []
  };
}


function browserEmptyData() {
  return {
    meta: {
      version: 1,
      sourceFile: '',
      importedAt: '',
      startedAt: '',
      updatedAt: new Date().toISOString(),
      dataPath: 'Browser private storage'
    },
    salary: [],
    monthlyDetails: [],
    overtime: [],
    stockRevenue: [],
    daily: [],
    personalBalances: [],
    salarySheets: [],
    unpaidBills: []
  };
}

const storageKey = 'finance-tracker-web-data-v1';
const dbName = 'finance-tracker-web';
const dbVersion = 1;
const dbStore = 'app-data';
const dbRecordKey = 'finance-records';

function normalizeLoadedData(data) {
  const next = rehydrateArchives({ ...browserEmptyData(), ...(data || {}) });
  next.meta = { ...browserEmptyData().meta, ...(data?.meta || {}), dataPath: 'Browser private storage' };
  [...collections, 'salarySheets', 'unpaidBills'].forEach((collection) => {
    const records = Array.isArray(next[collection]) ? next[collection] : [];
    next[collection] = records
      .filter((record) => record && typeof record === 'object' && !Array.isArray(record))
      .map((record) => (record.id ? record : { ...record, id: id(collection) }));
  });
  return next;
}

// Backups written by the desktop app keep file bytes in `_archives` instead of an
// inline dataUrl. Rehydrate them so archived files are actually openable.
function rehydrateArchives(data) {
  const archives = data && data._archives;
  if (!archives) return data;
  const remaining = {};
  ['salarySheets', 'unpaidBills'].forEach((collection) => {
    const stored = Array.isArray(archives[collection]) ? archives[collection] : [];
    remaining[collection] = stored;
    if (!stored.length || !Array.isArray(data[collection])) return;
    const byName = new Map(stored.map((entry) => [entry.storedName, entry.contentBase64]));
    const merged = new Set();
    data[collection] = data[collection].map((item) => {
      if (item.dataUrl || !byName.get(item.storedName)) return item;
      const mime = /\.pdf$/i.test(item.originalName || '') ? 'application/pdf' : 'application/octet-stream';
      merged.add(item.storedName);
      return { ...item, dataUrl: `data:${mime};base64,${byName.get(item.storedName)}` };
    });
    // Drop what we folded in, so exports don't carry the same bytes twice.
    remaining[collection] = stored.filter((entry) => !merged.has(entry.storedName));
  });
  const leftover = Object.values(remaining).reduce((total, list) => total + list.length, 0);
  if (leftover) {
    data._archives = { ...archives, ...remaining };
  } else {
    delete data._archives;
  }
  return data;
}

function looksLikeBackup(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const known = [...collections, 'salarySheets', 'unpaidBills'];
  return known.some((key) => Array.isArray(data[key])) ||
    Boolean(data.meta && typeof data.meta === 'object' && !Array.isArray(data.meta));
}

function openAppDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const request = indexedDB.open(dbName, dbVersion);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(dbStore);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(key) {
  const db = await openAppDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(dbStore, 'readonly');
    const request = transaction.objectStore(dbStore).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

async function idbSet(key, value) {
  const db = await openAppDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(dbStore, 'readwrite');
    transaction.objectStore(dbStore).put(value, key);
    transaction.oncomplete = () => {
      db.close();
      resolve(value);
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

async function idbDelete(key) {
  const db = await openAppDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(dbStore, 'readwrite');
    transaction.objectStore(dbStore).delete(key);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

async function loadStoredData() {
  try {
    const data = await idbGet(dbRecordKey);
    if (data) return normalizeLoadedData(data);
    const legacy = localStorage.getItem(storageKey);
    if (legacy) {
      const migrated = normalizeLoadedData(JSON.parse(legacy));
      await idbSet(dbRecordKey, migrated);
      localStorage.removeItem(storageKey);
      return migrated;
    }
  } catch (error) {
    const raw = localStorage.getItem(storageKey);
    if (raw) return normalizeLoadedData(JSON.parse(raw));
  }
  return browserEmptyData();
}

async function saveStoredData(data) {
  const next = normalizeLoadedData(data);
  next.meta.updatedAt = new Date().toISOString();
  try {
    await idbSet(dbRecordKey, next);
    localStorage.removeItem(storageKey);
  } catch (error) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch (fallbackError) {
      throw new Error('Could not save: this browser\'s storage is full or unavailable. Export a JSON backup now.');
    }
  }
  return next;
}

async function clearStoredData() {
  try {
    await idbDelete(dbRecordKey);
  } catch (error) {
    // localStorage fallback below still clears usable data.
  }
  localStorage.removeItem(storageKey);
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function chooseFiles({ accept = '', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    let settled = false;
    const finish = (files) => {
      if (settled) return;
      settled = true;
      resolve(files);
    };
    input.addEventListener('change', () => finish([...input.files]));
    input.addEventListener('cancel', () => finish([]));
    window.addEventListener('focus', () => setTimeout(() => finish([]), 500), { once: true });
    input.click();
  });
}

function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function dataUrlToBlob(dataUrl) {
  const [header, payload] = String(dataUrl || '').split(',');
  const mime = (header.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
  const binary = atob(payload || '');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

function openStoredFile(entry) {
  if (!entry?.dataUrl) {
    alert(`"${entry?.originalName || entry?.title || 'This file'}" is listed but its contents are missing from this backup, so it cannot be opened.`);
    return;
  }
  const url = URL.createObjectURL(dataUrlToBlob(entry.dataUrl));
  const opened = window.open(url, '_blank');
  if (opened) {
    opened.opener = null;
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return;
  }
  const link = document.createElement('a');
  link.href = url;
  link.download = entry.originalName || entry.title || 'saved-file';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

window.financeApi = {
  async load() {
    return loadStoredData();
  },
  async save(data) {
    return saveStoredData(data);
  },
  async startBlank() {
    const data = browserEmptyData();
    data.meta.startedAt = new Date().toISOString();
    return saveStoredData(data);
  },
  async clearAll() {
    await clearStoredData();
    const data = browserEmptyData();
    data.meta.startedAt = new Date().toISOString();
    return saveStoredData(data);
  },
  async importExcel() {
    const [file] = await chooseFiles({ accept: '.json,application/json' });
    if (!file) return null;
    const imported = JSON.parse(await readFileAsText(file));
    if (!looksLikeBackup(imported)) {
      throw new Error(`"${file.name}" is not a Finance Tracker backup, so nothing was imported.`);
    }
    const data = normalizeLoadedData(imported);
    data.meta.sourceFile = file.name;
    data.meta.importedAt = new Date().toISOString();
    data.meta.startedAt = data.meta.startedAt || data.meta.importedAt;
    return saveStoredData(data);
  },
  async exportExcel(data) {
    const next = normalizeLoadedData(data);
    next.meta.updatedAt = new Date().toISOString();
    const filename = `FinanceTracker-${new Date().toISOString().slice(0, 10)}.json`;
    downloadText(filename, JSON.stringify(next, null, 2));
    return filename;
  },
  async addSalarySheetsFromFiles(files) {
    return Promise.all((files || []).map(async (file) => ({
      id: id('salary-sheet'),
      originalName: file.name,
      storedName: file.name,
      size: file.size,
      type: file.type,
      dataUrl: await readFileAsDataUrl(file),
      savedAt: new Date().toISOString()
    })));
  },
  async chooseSalarySheets() {
    return this.addSalarySheetsFromFiles(await chooseFiles({ accept: '.xlsx,.xls,.numbers,.pdf,.csv,.txt,image/*', multiple: true }));
  },
  async openSalarySheet(storedName) {
    const sheet = (state.salarySheets || []).find((item) => item.storedName === storedName);
    openStoredFile(sheet);
    return '';
  },
  async salarySheetPreviewUrl(storedName) {
    return (state.salarySheets || []).find((item) => item.storedName === storedName)?.dataUrl || '';
  },
  async deleteSalarySheet() { return true; },
  async chooseUnpaidBillFiles() {
    return chooseFiles({ accept: '.pdf,image/*,.xlsx,.xls,.numbers,.txt', multiple: true });
  },
  async addUnpaidBills(entries) {
    return Promise.all((entries || []).map(async ({ file, title }) => ({
      id: id('unpaid-bill'),
      title: title || file.name,
      originalName: file.name,
      storedName: `${Date.now()}-${file.name}`,
      size: file.size,
      type: file.type,
      dataUrl: await readFileAsDataUrl(file),
      savedAt: new Date().toISOString()
    })));
  },
  async openUnpaidBill(storedName) {
    const bill = (state.unpaidBills || []).find((item) => item.storedName === storedName);
    openStoredFile(bill);
    return '';
  },
  async unpaidBillPreviewUrl(storedName) {
    return (state.unpaidBills || []).find((item) => item.storedName === storedName)?.dataUrl || '';
  },
  async deleteUnpaidBill() { return true; }
};

async function loadDemoData() {
  if (!confirm('Load demo data? This replaces current records. Export a backup first if you need to keep current data.')) return;
  await window.financeApi.clearAll();
  state = await buildDemoData();
  render();
  await save();
  setSaveState('Demo loaded');
}

async function clearAllData() {
  if (!confirm('Before clearing all data, export a backup and keep it somewhere safe. Continue only if you are sure.')) return;
  if (!confirm('This will delete all app records and archived salary/bill files from this app data folder. Continue?')) return;
  state = await window.financeApi.clearAll();
  state.salarySheets = state.salarySheets || [];
  state.unpaidBills = state.unpaidBills || [];
  render();
  setSaveState('Cleared');
}

async function addSalarySheetsFromFiles(files) {
  const savedSheets = await window.financeApi.addSalarySheetsFromFiles(files);
  if (!savedSheets.length) return;
  state.salarySheets = [...(state.salarySheets || []), ...savedSheets];
  renderSalarySheets();
  await save();
}

async function addUnpaidBillsFromFiles(files) {
  const entries = [];
  for (const file of files) {
    const fileName = file.name || 'Unpaid bill';
    const defaultTitle = fileName.replace(/\.[^.]+$/, '');
    const title = prompt(`Title for this unpaid bill: ${fileName}`, defaultTitle);
    if (title && title.trim()) entries.push({ file, title: title.trim() });
  }
  if (!entries.length) return;
  const savedBills = await window.financeApi.addUnpaidBills(entries);
  if (!savedBills.length) return;
  state.unpaidBills = [...(state.unpaidBills || []), ...savedBills];
  renderUnpaidBills();
  await save();
}

async function chooseUnpaidBills() {
  const files = await window.financeApi.chooseUnpaidBillFiles();
  if (!files.length) return;
  await addUnpaidBillsFromFiles(files);
}

async function chooseSalarySheets() {
  const savedSheets = await window.financeApi.chooseSalarySheets();
  if (!savedSheets.length) return;
  state.salarySheets = [...(state.salarySheets || []), ...savedSheets];
  renderSalarySheets();
  await save();
}

async function deleteSalarySheet(sheetId) {
  const sheet = (state.salarySheets || []).find((item) => item.id === sheetId);
  if (!sheet || !confirm('Delete this saved salary sheet?')) return;
  await window.financeApi.deleteSalarySheet(sheet.storedName);
  state.salarySheets = (state.salarySheets || []).filter((item) => item.id !== sheetId);
  renderSalarySheets();
  await save();
}

async function deleteUnpaidBill(billId) {
  const bill = (state.unpaidBills || []).find((item) => item.id === billId);
  if (!bill || !confirm('Delete this saved unpaid bill?')) return;
  await window.financeApi.deleteUnpaidBill(bill.storedName);
  state.unpaidBills = (state.unpaidBills || []).filter((item) => item.id !== billId);
  renderUnpaidBills();
  await save();
}

async function previewArchivedFile(kind, storedName, title) {
  const url = kind === 'salary'
    ? await window.financeApi.salarySheetPreviewUrl(storedName)
    : await window.financeApi.unpaidBillPreviewUrl(storedName);
  if (!url) {
    alert(`"${title || storedName}" is listed but its file contents are missing from this backup, so there is nothing to preview.`);
    return;
  }
  document.getElementById('previewTitle').textContent = title || 'Preview';
  document.getElementById('previewBody').innerHTML = isImageFile(storedName) || isImageFile(title)
    ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(title || 'Preview')}">`
    : `<iframe src="${escapeHtml(url)}" title="${escapeHtml(title || 'Preview')}"></iframe>`;
  document.getElementById('previewDialog').showModal();
}

function bindEvents() {
  document.querySelector('.chart-tablist').addEventListener('click', (event) => {
    const tab = event.target.closest('button[data-chart]');
    if (tab) switchChart(tab.dataset.chart);
  });
  document.querySelector('.chart-tablist').addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    switchChart(activeChart === 'salary' ? 'stock' : 'salary');
    document.querySelector('.chart-tablist [aria-selected="true"]').focus();
  });
  document.getElementById('kpis').addEventListener('click', (event) => {
    const tile = event.target.closest('button[data-view]');
    if (tile) switchView(tile.dataset.view);
  });
  document.getElementById('nav').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (!button) return;
    switchView(button.dataset.view);
    // On the stacked layout the nav sits above the content, so a tap would
    // otherwise leave you looking at the menu you just used.
    if (window.matchMedia('(max-width: 980px)').matches) {
      document.querySelector('.topbar')?.scrollIntoView({ block: 'start' });
    }
  });
  document.body.addEventListener('click', (event) => {
    const previewSheet = event.target.closest('[data-preview-salary-sheet]');
    if (previewSheet) previewArchivedFile('salary', previewSheet.dataset.previewSalarySheet, previewSheet.dataset.previewTitle);
    const openSheet = event.target.closest('[data-open-salary-sheet]');
    if (openSheet) window.financeApi.openSalarySheet(openSheet.dataset.openSalarySheet);
    const deleteSheet = event.target.closest('[data-delete-salary-sheet]');
    if (deleteSheet) deleteSalarySheet(deleteSheet.dataset.deleteSalarySheet);
    const previewBill = event.target.closest('[data-preview-unpaid-bill]');
    if (previewBill) previewArchivedFile('bill', previewBill.dataset.previewUnpaidBill, previewBill.dataset.previewTitle);
    const openBill = event.target.closest('[data-open-unpaid-bill]');
    if (openBill) window.financeApi.openUnpaidBill(openBill.dataset.openUnpaidBill);
    const deleteBill = event.target.closest('[data-delete-unpaid-bill]');
    if (deleteBill) deleteUnpaidBill(deleteBill.dataset.deleteUnpaidBill);
    const add = event.target.closest('[data-add]');
    if (add) openEditor(add.dataset.add, null);
    const edit = event.target.closest('[data-edit]');
    if (edit) {
      const item = state[edit.dataset.edit].find((record) => record.id === edit.dataset.id);
      openEditor(edit.dataset.edit, item);
    }
    const del = event.target.closest('[data-delete]');
    if (del) deleteRecord(del.dataset.delete, del.dataset.id);
  });
  ['dashboardYear', 'salaryYearFilter', 'detailsYearFilter', 'stockYearFilter', 'dailyYearFilter', 'dailyMonthFilter', 'otYearFilter', 'otMonthFilter'].forEach((idName) => {
    document.getElementById(idName).addEventListener('change', render);
  });
  document.body.addEventListener('input', (event) => {
    const dailyInput = event.target.closest('.daily-cell-input');
    if (dailyInput) updateAmountInputClass(dailyInput);
  });
  document.body.addEventListener('focusout', (event) => {
    const dailyInput = event.target.closest('.daily-cell-input');
    const stockInput = event.target.closest('.stock-cell-input');
    if (!dailyInput && !stockInput) return;
    const incoming = event.relatedTarget && event.relatedTarget.closest
      ? event.relatedTarget.closest('.daily-cell-input, .stock-cell-input')
      : null;
    const nextSelector = incoming ? gridCellSelector(incoming) : '';
    if (dailyInput) saveDailyCell(dailyInput);
    if (stockInput) saveStockCell(stockInput);
    if (!nextSelector) return;
    const replacement = document.querySelector(nextSelector);
    if (replacement) replacement.focus();
  });
  document.body.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('.daily-cell-input, .stock-cell-input')) {
      event.preventDefault();
      event.target.blur();
    }
  });
  document.getElementById('otQuickForm').addEventListener('submit', addQuickOtEntry);
  document.getElementById('editOtSalaryDetail').addEventListener('click', editCurrentOtSalaryDetail);
  document.getElementById('saveNow').addEventListener('click', save);
  document.getElementById('globalSearch').addEventListener('input', debounce(render, 180));
  // Canvases are sized from their rendered box, so a resized window otherwise
  // leaves a stale, stretched bitmap behind.
  let wasNarrow = narrowScreen();
  window.addEventListener('resize', debounce(() => {
    if (activeView === 'dashboard') renderCharts();
    if (narrowScreen() !== wasNarrow) {
      wasNarrow = narrowScreen();
      if (activeView === 'daily') render();
    }
  }, 150));
  document.getElementById('setupImportExcel').addEventListener('click', importExcelWithConfirmation);
  document.getElementById('dataImportExcel').addEventListener('click', importExcelWithConfirmation);
  document.getElementById('setupLoadDemoData').addEventListener('click', loadDemoData);
  document.getElementById('startBlank').addEventListener('click', async () => {
    state = await window.financeApi.startBlank();
    render();
    setSaveState('Started');
  });
  document.getElementById('dataExportExcel').addEventListener('click', async () => {
    const output = await window.financeApi.exportExcel(state);
    if (output) setSaveState(`Exported: ${output}`);
  });
  document.getElementById('loadDemoData').addEventListener('click', loadDemoData);
  document.getElementById('clearAllData').addEventListener('click', clearAllData);
  document.getElementById('chooseSalarySheets').addEventListener('click', chooseSalarySheets);
  document.getElementById('chooseUnpaidBills').addEventListener('click', chooseUnpaidBills);
  const dropZone = document.getElementById('salarySheetDropZone');
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
    const files = [...event.dataTransfer.files];
    addSalarySheetsFromFiles(files);
  });
  const billDropZone = document.getElementById('unpaidBillDropZone');
  billDropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    billDropZone.classList.add('dragging');
  });
  billDropZone.addEventListener('dragleave', () => billDropZone.classList.remove('dragging'));
  billDropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    billDropZone.classList.remove('dragging');
    const files = [...event.dataTransfer.files];
    addUnpaidBillsFromFiles(files);
  });
  document.getElementById('closePreview').addEventListener('click', () => {
    document.getElementById('previewDialog').close();
  });
  document.getElementById('cancelDialog').addEventListener('click', () => document.getElementById('recordDialog').close());
  document.getElementById('closeDialog').addEventListener('click', () => document.getElementById('recordDialog').close());
  document.getElementById('previewDialog').addEventListener('close', () => {
    document.getElementById('previewBody').innerHTML = '';
  });
  document.getElementById('recordForm').addEventListener('submit', (event) => {
    event.preventDefault();
    saveDialogRecord();
    document.getElementById('recordDialog').close();
  });
}

async function init() {
  try {
    state = await window.financeApi.load();
  } catch (error) {
    console.error(error);
    state = browserEmptyData();
    setSaveState('Storage unavailable');
  }
  state.salarySheets = state.salarySheets || [];
  state.unpaidBills = state.unpaidBills || [];
  bindEvents();
  switchView('dashboard');
  if (document.getElementById('saveState').textContent === 'Loading...') {
    setSaveState('Ready');
  }
}

init();
