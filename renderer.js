import { searchRecords as findSearchRecords, searchSnippet } from './search.mjs';
import { calculateSavings, expenseTotalForPeriod, stockPerformanceTone } from './finance-metrics.mjs';

let firebaseClientPromise = null;
function firebaseClient() {
  firebaseClientPromise ||= import('./firebase-client.mjs');
  return firebaseClientPromise;
}

let state = null;
let activeView = 'dashboard';
let activeChart = 'salary';
let dialogContext = null;
let visibleSearchResults = [];
let searchHighlightTimer = null;
let saveVersion = 0;
let persistedSaveVersion = 0;
let activeSaveCount = 0;
let accountUser = null;
let cloudSyncEnabled = false;
let accountTransitioning = false;
let currentStorageRecordKey = 'finance-records';
const themeStorageKey = 'finance-records-theme';
// Ocean and Dark only: the old Light theme differed from Ocean by a few greys and
// read as the same screen, so a saved 'light' now lands on Ocean.
const supportedThemes = new Set(['ocean', 'dark']);
const themeOrder = ['ocean', 'dark'];
const themeLabels = { ocean: 'Ocean', dark: 'Dark' };

function preferredTheme() {
  const saved = localStorage.getItem(themeStorageKey);
  return supportedThemes.has(saved) ? saved : 'ocean';
}

function applyTheme(theme, persist = true) {
  const selected = supportedThemes.has(theme) ? theme : 'ocean';
  document.documentElement.dataset.theme = selected;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', selected === 'dark' ? '#10232c' : selected === 'light' ? '#f3f6f8' : '#2b83a8');
  const button = document.getElementById('themeButton');
  const nextTheme = themeOrder[(themeOrder.indexOf(selected) + 1) % themeOrder.length];
  if (button) {
    button.dataset.theme = selected;
    // A switch, so the state lives in aria-checked and the name stays put.
    button.setAttribute('aria-checked', String(selected === 'dark'));
    button.setAttribute('aria-label', `Dark theme. ${themeLabels[selected]} selected`);
    button.title = `Theme: ${themeLabels[selected]} - switch to ${themeLabels[nextTheme]}`;
  }
  const buttonText = document.getElementById('themeButtonText');
  if (buttonText) buttonText.textContent = `${themeLabels[selected]} theme`;
  Object.assign(chartInk, chartPalettes[selected]);
  if (persist) localStorage.setItem(themeStorageKey, selected);
  if (state && activeView === 'dashboard') renderCharts();
}

const schemas = {
  salary: [
    ['year', 'Year', 'number'], ['month', 'Month'], ['salary', 'Gross Income', 'number'],
    ['takeHome', 'Take-home', 'number'], ['plannedSavings', 'Savings Goal', 'number'],
    ['expenseTotal', 'Expenditures', 'number'], ['actualSavings', 'Actual Savings', 'number'],
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
  ],
  expenses: [
    ['year', 'Year', 'number'], ['month', 'Month'], ['day', 'Day', 'number'],
    ['category', 'Category / Name'], ['amount', 'Amount', 'number'], ['note', 'Note']
  ]
};

const titles = {
  dashboard: 'Dashboard',
  salary: 'Monthly Savings',
  details: 'Salary Details',
  overtime: 'Overtime',
  stocks: 'Stock Revenue',
  daily: 'Daily Records',
  expenses: 'Expenditures',
  balances: 'Debt Records',
  data: 'Backup & Import',
  help: 'Help'
};

const collections = ['salary', 'monthlyDetails', 'overtime', 'stockRevenue', 'daily', 'expenses', 'personalBalances'];

const searchSections = [
  { collection: 'salary', view: 'salary', label: 'Monthly Savings', keywords: ['salary', 'income', 'savings'] },
  { collection: 'monthlyDetails', view: 'details', label: 'Salary Details', keywords: ['salary', 'payroll', 'income'] },
  { collection: 'overtime', view: 'overtime', label: 'Overtime', keywords: ['overtime', 'ot'] },
  { collection: 'stockRevenue', view: 'stocks', label: 'Stock Revenue', keywords: ['stock', 'stocks', 'revenue', 'win'] },
  { collection: 'daily', view: 'daily', label: 'Daily Records', keywords: ['daily', 'stock', 'trading'] },
  { collection: 'expenses', view: 'expenses', label: 'Expenditures', keywords: ['expense', 'expenses', 'spending', 'cost'] },
  { collection: 'personalBalances', view: 'balances', label: 'Debt Records', keywords: ['debt', 'balance', 'lender'] },
  // Last, so records always list ahead of the explanations.
  {
    collection: 'help',
    view: 'help',
    label: 'Help',
    keywords: ['how', 'explain'],
    fields: [['heading', 'Section'], ['topic', 'Topic'], ['text', 'Help text']]
  }
];

// The workbook mirrors the app: one sheet per menu, columns headed the way the
// tables head them, so a row in Excel reads like the row on screen.
const archiveFields = [
  ['originalName', 'File'], ['title', 'Title'], ['savedAt', 'Saved'],
  ['size', 'Size (bytes)'], ['type', 'Type'], ['storedName', 'Stored As']
];

const workbookSheets = [
  ['Monthly Savings', 'salary', () => schemas.salary],
  ['Salary Details', 'monthlyDetails', () => schemas.monthlyDetails],
  ['Overtime', 'overtime', () => schemas.overtime],
  ['Stock Revenue', 'stockRevenue', () => schemas.stockRevenue],
  ['Daily Records', 'daily', () => schemas.daily],
  ['Expenditures', 'expenses', () => schemas.expenses],
  ['Debt Records', 'personalBalances', () => schemas.personalBalances],
  ['Salary Sheet Archive', 'salarySheets', () => archiveFields],
  ['Unpaid Bills Archive', 'unpaidBills', () => archiveFields]
];
const computedFields = {
  monthlyDetails: ['grossTotal', 'totalDeduction', 'received'],
  overtime: ['amount'],
  stockRevenue: ['monthlyRevenue', 'surplus', 'verdict'],
  salary: ['expenseTotal', 'actualSavings', 'cumulativeCapital', 'savingsRate']
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

// 'Ready' and friends say nothing a reader needs, so they stay in the live
// region for screen readers and out of the header.
const quietSaveStates = new Set(['Ready', 'Loading...', 'Local mode']);

function setSaveState(text) {
  const element = document.getElementById('saveState');
  element.textContent = text;
  element.classList.toggle('sr-only', quietSaveStates.has(text));
}

function updateSaveButton() {
  const saveButton = document.getElementById('saveNow');
  if (!saveButton) return;
  const hasUnsavedChanges = saveVersion > persistedSaveVersion;
  saveButton.hidden = !hasUnsavedChanges;
  saveButton.disabled = activeSaveCount > 0;
}

function hasRecords() {
  return collections.some((collection) => (state[collection] || []).length > 0);
}

function searchText() {
  return (document.getElementById('globalSearch')?.value || '').trim();
}

function compareSearchRecords(a, b) {
  const yearDifference = Number(b.year || 0) - Number(a.year || 0);
  if (yearDifference) return yearDifference;
  const monthDifference = monthIndex(b.month) - monthIndex(a.month);
  if (monthDifference) return monthDifference;
  const dayDifference = Number(b.day || 0) - Number(a.day || 0);
  if (dayDifference) return dayDifference;
  return String(b.dateOrLabel || '').localeCompare(String(a.dateOrLabel || ''));
}

// Help is searched straight from the page, so results can never drift from what
// it says: one entry per term and its definition, one per standalone paragraph.
function helpSearchRecords() {
  return [...document.querySelectorAll('#help .help-panel')].flatMap((panel, p) => {
    const heading = panel.querySelector('h3')?.textContent.trim() || 'Help';
    const paragraphs = [...panel.querySelectorAll(':scope > p')].map((paragraph, k) => ({
      id: `help-${p}-p${k}`, heading, topic: heading, text: paragraph.textContent, element: paragraph
    }));
    const terms = [...panel.querySelectorAll('.help-list dt')].map((term, k) => ({
      id: `help-${p}-t${k}`, heading, topic: term.textContent.trim(), text: term.nextElementSibling?.textContent || '', element: term
    }));
    return [...paragraphs, ...terms];
  });
}

function recordsForGlobalSearch(section) {
  if (section.collection === 'help') return helpSearchRecords();
  if (section.collection === 'stockRevenue') {
    return yearsFrom(state.stockRevenue)
      .flatMap((year) => normalizeStockYear(year))
      .sort(compareSearchRecords);
  }
  return (state[section.collection] || []).slice().sort(compareSearchRecords);
}

function preparedSearchSections() {
  return searchSections.map((section) => ({
    ...section,
    fields: section.fields || schemas[section.collection],
    records: recordsForGlobalSearch(section)
  }));
}

function searchResultTitle(section, record) {
  if (section.collection === 'help') {
    return record.topic === record.heading ? record.heading : `${record.heading} · ${record.topic}`;
  }
  if (section.collection === 'personalBalances') {
    return [record.group, record.dateOrLabel].filter(Boolean).join(' · ') || 'Debt record';
  }
  const period = [normalizeMonth(record.month) || record.month, record.day, record.year]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .join(' · ');
  return period || section.label;
}

function truncateSearchValue(value, maxLength = 90) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function matchedFieldSummary(result) {
  const locationFields = new Set(['year', 'month', 'day']);
  const fields = result.matchingFields.filter(({ key, value }) =>
    !locationFields.has(key) && value !== undefined && value !== null && String(value).trim() !== ''
  );
  if (!fields.length) return '';
  return fields.slice(0, 2).map(({ key, label, value }) =>
    `${label}: ${truncateSearchValue(formatValue(key, value))}`
  ).join(' · ');
}

function defaultSearchResultSummary(section, record) {
  if (section.collection === 'salary') {
    return `Gross ${yen(record.salary)} · Saved ${yen(record.actualSavings)}`;
  }
  if (section.collection === 'monthlyDetails') {
    return `Gross ${yen(record.grossTotal)} · Net ${yen(record.received)}`;
  }
  if (section.collection === 'overtime') {
    const hours = Number(record.hours || 0) + Number(record.miscHours || 0);
    return `${Math.round(hours * 100) / 100} hours · ${yen(record.amount)}`;
  }
  if (section.collection === 'stockRevenue') {
    return `Actual ${yen(record.actualCumulative)} · Vs target ${yen(record.surplus)}`;
  }
  if (section.collection === 'daily') {
    const detail = record.note || record.status;
    return `${yen(record.amount)}${detail ? ` · ${truncateSearchValue(detail)}` : ''}`;
  }
  return `${yen(record.amount)}${record.note ? ` · ${truncateSearchValue(record.note)}` : ''}`;
}

function closeGlobalSearch() {
  const results = document.getElementById('globalSearchResults');
  results.hidden = true;
  document.getElementById('globalSearch').setAttribute('aria-expanded', 'false');
}

function renderGlobalSearch() {
  const query = searchText();
  const content = document.getElementById('globalSearchResultsContent');
  const status = document.getElementById('globalSearchStatus');
  if (!query) {
    visibleSearchResults = [];
    content.innerHTML = '';
    status.textContent = '';
    closeGlobalSearch();
    return;
  }

  normalizeState();
  const { matches, total } = findSearchRecords(preparedSearchSections(), query);
  visibleSearchResults = matches;
  const resultWord = total === 1 ? 'result' : 'results';
  status.textContent = total ? `${total} ${resultWord} for ${query}` : `No results for ${query}`;

  if (!total) {
    content.innerHTML = `
      <div class="search-results-head"><strong>Search results</strong><span>0 results</span></div>
      <p class="search-empty">Nothing in your records or Help matches “${escapeHtml(query)}”.</p>`;
  } else {
    const groups = new Map();
    matches.forEach((result, index) => {
      const entries = groups.get(result.section.collection) || [];
      entries.push({ result, index });
      groups.set(result.section.collection, entries);
    });
    const shownText = total > matches.length ? `Showing ${matches.length} of ${total}` : `${total} ${resultWord}`;
    content.innerHTML = `
      <div class="search-results-head"><strong>Search results</strong><span>${shownText}</span></div>
      ${[...groups.values()].map((entries) => {
        const { section } = entries[0].result;
        return `
          <section class="search-result-group" aria-labelledby="searchGroup-${section.collection}">
            <h3 id="searchGroup-${section.collection}">${escapeHtml(section.label)} <span>${entries.length}</span></h3>
            <ul>${entries.map(({ result, index }) => {
              const title = searchResultTitle(result.section, result.record);
              const summary = result.section.collection === 'help'
                ? searchSnippet(result.record.text, query)
                : matchedFieldSummary(result) || defaultSearchResultSummary(result.section, result.record);
              return `<li><button type="button" class="search-result-item" data-search-result="${index}">
                <strong>${escapeHtml(title)}</strong>
                <span>${escapeHtml(summary)}</span>
              </button></li>`;
            }).join('')}</ul>
          </section>`;
      }).join('')}`;
  }

  document.getElementById('globalSearchResults').hidden = false;
  document.getElementById('globalSearch').setAttribute('aria-expanded', 'true');
}

function setSearchDestinationFilters(section, record) {
  const year = String(Number(record.year || 0));
  const month = normalizeMonth(record.month);
  const dailyMonth = narrowScreen() ? month : '';
  const filterValues = {
    salary: [['salaryYearFilter', year]],
    monthlyDetails: [['detailsYearFilter', year]],
    overtime: [['otYearFilter', year], ['otMonthFilter', month]],
    stockRevenue: [['stockYearFilter', year]],
    daily: [['dailyYearFilter', year], ['dailyMonthFilter', dailyMonth]],
    expenses: [['expenseYearFilter', year], ['expenseMonthFilter', month]],
    personalBalances: []
  }[section.collection] || [];
  filterValues.forEach(([idName, value]) => {
    if (value !== undefined && value !== null && document.getElementById(idName)) {
      document.getElementById(idName).value = value;
    }
  });
}

function searchTargetFor(result) {
  const { section, record } = result;
  const view = document.getElementById(section.view);
  if (!view) return null;
  if (section.collection === 'help') return record.element?.isConnected ? record.element : null;
  if (section.collection === 'daily') {
    return [...view.querySelectorAll('.daily-cell-input')].find((input) =>
      Number(input.dataset.dailyYear) === Number(record.year) &&
      input.dataset.dailyMonth === normalizeMonth(record.month) &&
      Number(input.dataset.dailyDay) === Number(record.day)
    )?.closest('.daily-day-cell') || null;
  }
  if (section.collection === 'stockRevenue') {
    return [...view.querySelectorAll('[data-stock-row-year]')].find((row) =>
      Number(row.dataset.stockRowYear) === Number(record.year) &&
      row.dataset.stockRowMonth === normalizeMonth(record.month)
    ) || null;
  }
  return [...view.querySelectorAll('tr[data-record-id]')].find((row) =>
    row.dataset.recordId === String(record.id)
  ) || null;
}

function revealSearchTarget(result) {
  document.querySelectorAll('.search-target').forEach((element) => element.classList.remove('search-target'));
  const target = searchTargetFor(result);
  if (!target) {
    document.getElementById('globalSearchStatus').textContent = `Opened ${result.section.label}`;
    return;
  }
  clearTimeout(searchHighlightTimer);
  // A Help term lights up together with its definition.
  const partner = target.matches('dt') ? target.nextElementSibling : null;
  target.classList.add('search-target');
  partner?.classList.add('search-target');
  target.tabIndex = -1;
  target.scrollIntoView({ block: 'center', inline: 'center' });
  target.focus({ preventScroll: true });
  document.getElementById('globalSearchStatus').textContent =
    `Opened ${result.section.label}: ${searchResultTitle(result.section, result.record)}`;
  searchHighlightTimer = setTimeout(() => {
    target.classList.remove('search-target');
    partner?.classList.remove('search-target');
    target.removeAttribute('tabindex');
  }, 2600);
}

function openGlobalSearchResult(index) {
  const result = visibleSearchResults[index];
  if (!result) return;
  closeGlobalSearch();
  switchView(result.section.view);
  setSearchDestinationFilters(result.section, result.record);
  render();
  requestAnimationFrame(() => revealSearchTarget(result));
}

function showSetupIfNeeded() {
  const overlay = document.getElementById('setupOverlay');
  overlay.hidden = hasRecords() || Boolean(state.meta?.startedAt);
}

function dataHasRecords(data) {
  return collections.some((collection) => (data?.[collection] || []).length > 0);
}

function dataHasArchives(data) {
  return ['salarySheets', 'unpaidBills'].some((collection) => (data?.[collection] || []).length > 0);
}

function accountStorageKey(uid) {
  return `${dbRecordKey}-user-${uid}`;
}

function cloudDataPath(user = accountUser) {
  return `Firebase cloud sync · ${user?.email || user?.displayName || 'signed in'}`;
}

function updateAccountUI(message = '') {
  const signedIn = Boolean(accountUser);
  const accountName = document.getElementById('accountName');
  const accountMode = document.getElementById('accountMode');
  const signInButton = document.getElementById('accountSignIn');
  const setupSignIn = document.getElementById('setupSignIn');
  const signOutButton = document.getElementById('accountSignOut');
  const syncButton = document.getElementById('accountSyncNow');
  if (!accountName) return;
  accountName.textContent = signedIn ? (accountUser.displayName || accountUser.email || 'Signed in') : 'Local only';
  accountMode.textContent = message || (signedIn && cloudSyncEnabled ? 'Records sync between devices' : 'Records stay on this device');
  signInButton.hidden = signedIn;
  setupSignIn.hidden = signedIn;
  signOutButton.hidden = !signedIn;
  syncButton.hidden = !signedIn || !cloudSyncEnabled;
  const accountDataText = document.getElementById('accountDataText');
  if (accountDataText) {
    accountDataText.textContent = signedIn
      ? `${accountUser.email || accountUser.displayName || 'Signed in'}${cloudSyncEnabled ? ' · syncing' : ''}`
      : 'Local only';
  }
}

function cloudStateWithLocalArchives(cloudData, localData, user) {
  const next = normalizeLoadedData({
    ...cloudData,
    salarySheets: localData.salarySheets || [],
    unpaidBills: localData.unpaidBills || []
  });
  next.meta = {
    ...next.meta,
    dataPath: cloudDataPath(user)
  };
  return next;
}

async function persistCloudCopy() {
  if (!accountUser || !cloudSyncEnabled) return false;
  if (!navigator.onLine) {
    state.meta.cloudPending = true;
    await saveStoredData(state);
    updateAccountUI('Offline · changes kept on this device');
    return false;
  }
  const { saveCloudState } = await firebaseClient();
  await saveCloudState(accountUser.uid, state);
  state.meta.cloudPending = false;
  state.meta.dataPath = cloudDataPath();
  await saveStoredData(state);
  updateAccountUI('Cloud sync is up to date');
  return true;
}

async function syncAccountNow() {
  if (!accountUser || !cloudSyncEnabled || accountTransitioning) return;
  setSaveState('Syncing...');
  updateAccountUI('Syncing records...');
  try {
    await persistCloudCopy();
    setSaveState(navigator.onLine ? 'Synced' : 'Saved offline');
  } catch (error) {
    console.error(error);
    state.meta.cloudPending = true;
    await saveStoredData(state);
    setSaveState('Sync failed');
    updateAccountUI('Cloud unavailable · changes kept locally');
  }
}

async function activateAccount(user) {
  if (accountTransitioning) return;
  accountTransitioning = true;
  const localBeforeSignIn = state;
  accountUser = user;
  cloudSyncEnabled = false;
  currentStorageRecordKey = accountStorageKey(user.uid);
  updateAccountUI('Connecting to Firebase...');
  setSaveState('Connecting...');

  try {
    const accountCache = await loadStoredData();
    const { loadCloudState } = await firebaseClient();
    const cloud = await loadCloudState(user.uid);
    if (cloud.exists) {
      state = cloudStateWithLocalArchives(cloud.data, accountCache, user);
      cloudSyncEnabled = true;
      await saveStoredData(state);
      updateAccountUI('Cloud sync is up to date');
      setSaveState('Synced');
    } else {
      const migrationSource = dataHasRecords(localBeforeSignIn) || dataHasArchives(localBeforeSignIn)
        ? localBeforeSignIn
        : accountCache;
      const shouldMigrate = (dataHasRecords(migrationSource) || dataHasArchives(migrationSource)) && confirm(
        'Move this device\'s records into your account?\n\nFinancial records will sync through Firebase. Archived salary sheets and bill files will remain only on this device. Your existing local copy will not be deleted.'
      );
      state = shouldMigrate ? normalizeLoadedData(migrationSource) : browserEmptyData();
      state.meta.startedAt = state.meta.startedAt || new Date().toISOString();
      state.meta.dataPath = cloudDataPath(user);
      cloudSyncEnabled = true;
      await saveStoredData(state);
      if (navigator.onLine) await persistCloudCopy();
      updateAccountUI(navigator.onLine ? 'Cloud sync is up to date' : 'Offline · changes kept on this device');
      setSaveState(navigator.onLine ? 'Synced' : 'Saved offline');
    }
  } catch (error) {
    console.error(error);
    const cached = await loadStoredData();
    state = cached;
    state.meta.dataPath = `Account cache · ${user.email || user.displayName || 'signed in'}`;
    cloudSyncEnabled = true;
    updateAccountUI('Cloud unavailable · using this device’s cache');
    setSaveState('Offline cache');
  } finally {
    accountTransitioning = false;
    state.salarySheets = state.salarySheets || [];
    state.unpaidBills = state.unpaidBills || [];
    render();
  }
}

async function activateLocalMode() {
  if (accountTransitioning) return;
  accountTransitioning = true;
  accountUser = null;
  cloudSyncEnabled = false;
  const { resetCloudBaseline } = await firebaseClient();
  resetCloudBaseline();
  currentStorageRecordKey = dbRecordKey;
  state = await loadStoredData();
  state.salarySheets = state.salarySheets || [];
  state.unpaidBills = state.unpaidBills || [];
  updateAccountUI();
  setSaveState('Local mode');
  accountTransitioning = false;
  render();
}

async function beginGoogleSignIn() {
  setSaveState('Opening sign in...');
  try {
    const { signInWithGoogle } = await firebaseClient();
    await signInWithGoogle();
  } catch (error) {
    console.error(error);
    const cancelled = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(error?.code);
    setSaveState(cancelled ? 'Sign in cancelled' : 'Sign in failed');
    if (!cancelled) {
      alert(error?.message || 'Google sign-in failed.');
    }
  }
}

let saveErrorNotified = false;

async function save() {
  const version = ++saveVersion;
  activeSaveCount += 1;
  updateSaveButton();
  setSaveState('Saving...');
  try {
    state = await window.financeApi.save(state);
    if (cloudSyncEnabled) {
      const synced = await persistCloudCopy();
      setSaveState(synced ? 'Synced' : 'Saved offline');
    } else {
      setSaveState('Saved');
    }
    persistedSaveVersion = Math.max(persistedSaveVersion, version);
    if (!cloudSyncEnabled) setTimeout(() => setSaveState('Ready'), 1200);
  } catch (error) {
    console.error(error);
    if (cloudSyncEnabled) {
      state.meta.cloudPending = true;
      try {
        await saveStoredData(state);
        persistedSaveVersion = Math.max(persistedSaveVersion, version);
      } catch (localError) {
        console.error(localError);
      }
      setSaveState('Saved locally');
      updateAccountUI('Cloud sync failed · changes kept locally');
    } else {
      setSaveState('Save failed');
    }
    if (!saveErrorNotified) {
      saveErrorNotified = true;
      alert(cloudSyncEnabled
        ? 'Your change is saved on this device, but cloud sync failed. Use Sync now when the connection is available.'
        : (error?.message || 'Saving failed. Export a JSON backup so you do not lose records.'));
    }
  } finally {
    activeSaveCount -= 1;
    updateSaveButton();
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
  // The year in hand comes from the dashboard, so it can be one this collection
  // has no records for - an old backup with no expenditures, say. List it too,
  // or the picker sits blank on a year the page is plainly showing.
  if (current !== undefined && current !== null && current !== '' &&
      !values.some((value) => String(value) === String(current))) {
    values = [...values, current].sort((a, b) => Number(a) - Number(b));
  }
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

function stockRecordsFor(year, month) {
  return (state.stockRevenue || []).filter((item) =>
    Number(item.year) === Number(year) && normalizeMonth(item.month) === month);
}

// A record whose month is written exactly as the canonical name wins over one that
// merely normalises to it, so a stray label cannot shadow the real month.
function preferredStockRecord(records, month) {
  return records.find((item) => String(item.month).trim() === month) || records[records.length - 1];
}

function normalizeStockYear(year) {
  const records = monthOptions
    .map(([month]) => preferredStockRecord(stockRecordsFor(year, month), month))
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
  // Post-2025 figures, to match the 650,000 employment-income deduction floor above.
  const basicDeduction = 580000;
  return Math.round(annualIncomeTaxFromTaxable(salaryIncome - socialDeduction - basicDeduction) / 12);
}

function overtimeAmountFor(year, month) {
  const normalizedMonth = normalizeMonth(month);
  const records = (state.overtime || []).map(normalizeOvertimeRecord).filter((item) =>
    Number(item.year || year) === Number(year) && normalizeMonth(item.month) === normalizedMonth
  );
  return sum(records, 'amount');
}

// Each month carries on from the month before it; every new year starts from zero.
function withCumulativeCapital(ordered) {
  let year = null;
  let running = 0;
  return ordered.map((item) => {
    if (Number(item.year) !== year) {
      year = Number(item.year);
      running = 0;
    }
    running += Number(item.actualSavings || 0);
    return { ...item, cumulativeCapital: running };
  });
}

function expenseTotalFor(year, month) {
  return expenseTotalForPeriod(state.expenses, year, month, normalizeMonth);
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
    const takeHome = received;
    const expenseTotal = expenseTotalFor(year, month);
    const actualSavings = calculateSavings(takeHome, expenseTotal);
    return {
      ...previous,
      id: previous.id || id('salary'),
      year,
      month,
      salary: grossTotal,
      takeHome,
      plannedSavings: Number(previous.plannedSavings || 0),
      expenseTotal,
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
    .map(({ derivedFromDetail, ...rest }) => {
      const takeHome = Number(rest.takeHome ?? rest.actualSavings ?? 0);
      const expenseTotal = expenseTotalFor(rest.year, rest.month);
      const actualSavings = calculateSavings(takeHome, expenseTotal);
      return {
        ...rest,
        takeHome,
        expenseTotal,
        actualSavings,
        savingsRate: Number(rest.salary || 0) ? actualSavings / Number(rest.salary || 0) : 0
      };
    });
  return withCumulativeCapital(sortRecordsByMonth([...derived, ...manualOnly]));
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

function selectedExpenseYear() {
  const years = yearsFrom(state.expenses);
  return Number(document.getElementById('expenseYearFilter')?.value || years[years.length - 1] || currentYear());
}

function selectedExpenseMonth() {
  return document.getElementById('expenseMonthFilter')?.value || '';
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

// Whether a month has happened is a calendar question. A bonus counts from the
// month it is paid in: June for the year's first, December for any later one — the
// order sortRecordsByMonth files them in. `records` is the list the row came from,
// which says which of the year's bonuses it is.
function monthHasElapsed(record, year, records) {
  let monthNumber = monthIndex(record.month);
  if (isBonusMonth(record.month)) {
    const bonuses = records.filter((item) => Number(item.year) === Number(year) && isBonusMonth(item.month));
    monthNumber = bonuses.indexOf(record) > 0 ? 12 : 6;
  }
  if (!monthNumber) return true;
  const now = new Date();
  if (Number(year) !== now.getFullYear()) return Number(year) < now.getFullYear();
  return monthNumber <= now.getMonth() + 1;
}

function valueExtremes(records, key) {
  if (!records.length) return null;
  return records.slice(1).reduce(({ highest, lowest }, record) => ({
    highest: Number(record[key] || 0) > Number(highest[key] || 0) ? record : highest,
    lowest: Number(record[key] || 0) < Number(lowest[key] || 0) ? record : lowest
  }), { highest: records[0], lowest: records[0] });
}

function recentMoneyTrend(records, key, label) {
  if (records.length < 2) return `More recorded months are needed to show the ${label} trend.`;
  const recent = records.slice(-3);
  const first = recent[0];
  const last = recent.at(-1);
  const delta = Number(last[key] || 0) - Number(first[key] || 0);
  const steadyBand = Math.max(1000, Math.abs(Number(first[key] || 0)) * 0.01);
  if (Math.abs(delta) <= steadyBand) {
    return `Recent ${label} is steady from ${first.month} to ${last.month}.`;
  }
  return `Recent ${label} is ${delta > 0 ? 'rising' : 'falling'}: ${last.month} is ${yen(Math.abs(delta))} ${delta > 0 ? 'above' : 'below'} ${first.month}.`;
}

function renderDashboardSummary({ year, salary, elapsed, elapsedMonths, projectedMonths, actualIncome, actualTakeHome, actualExpenses, actualSavings, stockLatest, stockRecord, stockTarget }) {
  const summary = document.querySelector('.dashboard-summary');
  const title = document.getElementById('dashboardSummaryTitle');
  let items;

  if (activeChart === 'stock') {
    title.textContent = 'Stock summary';
    summary.dataset.focus = 'stock';
    const stocks = normalizeStockYear(year).filter(stockHasActual);
    if (!stocks.length) {
      items = [`No stock result recorded for ${year} yet.`, 'Add at least two monthly actuals to see highs, lows and a recent trend.'];
    } else {
      const gap = stockLatest - stockTarget;
      const extremes = valueExtremes(stocks, 'actualCumulative');
      const moves = stocks.slice(1);
      const moveExtremes = valueExtremes(moves, 'monthlyRevenue');
      items = [
        stockRecord && stockTarget
          ? `Latest result is ${gap >= 0 ? `${yen(gap)} ahead of` : `${yen(Math.abs(gap))} below`} the ${stockRecord.month} cumulative target.`
          : `Latest recorded result is ${yen(stockLatest)} in ${stockRecord?.month || year}.`,
        `Highest cumulative result was ${yen(extremes.highest.actualCumulative)} in ${extremes.highest.month}; lowest was ${yen(extremes.lowest.actualCumulative)} in ${extremes.lowest.month}.`,
        !moves.length ? 'Add another monthly actual to compare month-to-month movement.'
          : moves.length === 1 ? `The recorded month-to-month move was ${yen(moves[0].monthlyRevenue)} in ${moves[0].month}.`
          : `Best monthly move was ${yen(moveExtremes.highest.monthlyRevenue)} in ${moveExtremes.highest.month}; weakest was ${yen(moveExtremes.lowest.monthlyRevenue)} in ${moveExtremes.lowest.month}.`,
        recentMoneyTrend(stocks, 'actualCumulative', 'cumulative stock trend')
      ];
    }
  } else {
    title.textContent = 'Salary summary';
    summary.dataset.focus = 'salary';
    const monthlySalary = sortRecordsByMonth(elapsed)
      .filter((record) => monthIndex(record.month) > 0 && Number(record.salary || 0) !== 0);
    const extremes = valueExtremes(monthlySalary, 'salary');
    const progress = elapsedMonths
      ? `${elapsedMonths} salary month${elapsedMonths === 1 ? '' : 's'} recorded${projectedMonths ? `; ${projectedMonths} future month${projectedMonths === 1 ? '' : 's'} included in projections` : ''}.`
      : `No completed salary months recorded for ${year} yet.`;
    const takeHome = actualIncome
      ? `Take-home is ${Math.round((actualTakeHome / actualIncome) * 100)}% of recorded gross income.`
      : 'Take-home percentage will appear once salary is recorded.';
    items = [
      `${progress} ${takeHome}`,
      `Recorded take-home is ${yen(actualTakeHome)}; after ${yen(actualExpenses)} of expenditures, savings are ${yen(actualSavings)}.`,
      extremes
        ? `Highest monthly gross was ${yen(extremes.highest.salary)} in ${extremes.highest.month}; lowest was ${yen(extremes.lowest.salary)} in ${extremes.lowest.month}.`
        : 'Monthly highs and lows will appear once salary is recorded.',
      recentMoneyTrend(monthlySalary, 'salary', 'monthly gross trend')
    ];
  }

  document.getElementById('dashboardSummary').innerHTML = items
    .map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

function renderKpis() {
  const year = currentYear();
  const salary = (state.salary || []).filter((item) => Number(item.year) === year);
  const elapsed = salary.filter((item) => monthHasElapsed(item, year, salary));
  const monthRows = salary.filter((item) => monthIndex(item.month) > 0);
  const elapsedMonths = monthRows.filter((item) => monthHasElapsed(item, year, salary)).length;
  const projectedMonths = monthRows.length - elapsedMonths;
  const debts = state.personalBalances;
  const actualIncome = sum(elapsed, 'salary');
  const projectedIncome = sum(salary, 'salary');
  const actualTakeHome = sum(elapsed, 'takeHome');
  const projectedTakeHome = sum(salary, 'takeHome');
  const yearExpenses = (state.expenses || []).filter((item) => Number(item.year) === year);
  const elapsedExpenses = yearExpenses.filter((item) => monthHasElapsed(item, year, yearExpenses));
  const actualExpenses = sum(elapsedExpenses, 'amount');
  const actualSavings = calculateSavings(actualTakeHome, actualExpenses);
  const stockLatest = latestStockActualForYear(year);
  const stockRecord = latestStockRecordForYear(year);
  const stockTarget = Number(stockRecord?.targetCumulative || 0);
  const debtTotal = sum(debts, 'amount');
  const lenders = new Set((debts || [])
    .map((item) => String(item.group || '').trim().toLowerCase())
    .filter(Boolean)).size;
  const { gap: stockGap, performance: stockPerformance } = stockPerformanceTone(stockLatest, stockTarget, Boolean(stockRecord));
  const stockToneLevel = stockRecord ? Math.round((stockPerformance + 1) * 4) : 'empty';
  const kpis = [
    ['Salary · Income', yen(actualIncome), '', `Take-home ${yen(actualTakeHome)}${projectedMonths ? ` · projected gross ${yen(projectedIncome)} · take-home ${yen(projectedTakeHome)}` : ''}`, 'tone-blue', 'salary'],
    ['Savings', yen(actualSavings), actualSavings >= 0 ? 'positive' : 'negative',
      `Take-home ${yen(actualTakeHome)} − expenses ${yen(actualExpenses)}`, actualSavings >= 0 ? 'tone-green' : 'tone-red', 'expenses'],
    ['Stock · Win Total', yen(stockLatest), stockGap > 0 ? 'positive' : stockGap < 0 ? 'negative' : '',
      stockRecord ? `${yen(Math.abs(stockGap))} ${stockGap >= 0 ? 'above' : 'below'} ${stockRecord.month} target` : 'No result recorded', `tone-performance performance-${stockToneLevel}`, 'stocks'],
    ['Outstanding Debt', yen(debtTotal), debtTotal > 0 ? 'debt' : '',
      debts.length ? `${debts.length} record${debts.length === 1 ? '' : 's'} · ${lenders} lender${lenders === 1 ? '' : 's'}` : '',
      'tone-red', 'balances']
  ];
  document.getElementById('kpis').innerHTML = kpis.map(([label, value, cls, hint, tone, view]) =>
    `<button type="button" class="kpi ${cls} ${tone}" data-view="${view}" aria-label="${escapeHtml(label)} — open ${escapeHtml(titles[view])}"><span>${label}</span><strong>${value}</strong>${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</button>`
  ).join('');
  renderDashboardSummary({ year, salary, elapsed, elapsedMonths, projectedMonths, actualIncome, actualTakeHome, actualExpenses, actualSavings, stockLatest, stockRecord, stockTarget });
}

// Both dashboard charts share one frame — a wrapping legend, a round-number
// y-axis and one slot per month — and draw their figures over it as lines.
const chartPalettes = {
  ocean: {
  background: '#ffffff', markerSurface: '#ffffff',
  text: '#22313a',
  muted: '#5b6d76',
  grid: '#e8eff2',
  baseline: '#b8c8cf',
  hover: '#edf4f7',
  bonus: '#fbf5e4',
  upcoming: '#8a9aa2',
  gross: '#256f8f',
  target: '#c98500',
  good: '#2e7d32',
  below: '#c33f3f',
  goodWash: 'rgba(46, 125, 50, .16)',
  belowWash: 'rgba(195, 63, 63, .16)'
  },
  dark: {
    background: '#131722', markerSurface: '#131722',
    text: '#d1d4dc', muted: '#9aa4b2', grid: '#2a2e39', baseline: '#4c525e', hover: '#1e222d',
    bonus: '#302b22', upcoming: '#8b95a5', gross: '#42a5f5', target: '#f0b53d', good: '#26a69a',
    below: '#f07070', goodWash: 'rgba(101, 200, 121, .18)', belowWash: 'rgba(240, 112, 112, .18)'
  }
};
const chartInk = { ...chartPalettes.ocean };
const chartFont = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
// Take-home under this share of gross income is drawn red.
const takeHomeFloor = 0.5;

function chartYen(value) {
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  const compact = (n) => String(Number(n.toFixed(2)));
  if (abs >= 1e6) return `${sign}¥${compact(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}¥${compact(abs / 1e3)}k`;
  return `${sign}¥${Math.round(abs)}`;
}

// Steps of 1, 2, 2.5 or 5 × a power of ten, so ticks read ¥100k / ¥200k rather
// than equal eighths of the maximum (¥44k, ¥131k). The 4% pad keeps the tallest
// mark off the top line. Of the steps nearest the wanted tick count, the one that
// wastes the least room above the data wins. Without `includeZero` (a zoomed-in
// chart) the axis fits the figures instead, never crossing zero when they all sit
// on one side of it.
function niceScale(values, targetTicks, includeZero = true) {
  if (!values.length) return null;
  let hi = Math.max(...values);
  let lo = Math.min(...values);
  if (includeZero) {
    hi = Math.max(0, hi) * 1.04;
    lo = Math.min(0, lo) * 1.04;
  } else {
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
    hi = hi <= 0 ? Math.min(0, hi + pad) : hi + pad;
    lo = lo >= 0 ? Math.max(0, lo - pad) : lo - pad;
  }
  if (hi === lo) return null;
  const magnitude = 10 ** Math.floor(Math.log10((hi - lo) / targetTicks));
  const scales = [1, 2, 2.5, 5, 10].map((factor) => {
    const step = factor * magnitude;
    const min = Math.floor(lo / step) * step;
    const max = Math.ceil(hi / step) * step;
    return { min, max, step, miss: Math.abs((max - min) / step - targetTicks) };
  });
  return scales.reduce((best, scale) =>
    scale.miss < best.miss || (scale.miss === best.miss && scale.max - scale.min < best.max - best.min) ? scale : best);
}

function prepareCanvas(canvas) {
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
  ctx.fillStyle = chartInk.background;
  ctx.fillRect(0, 0, w, h);
  return { ctx, w, h };
}

// A monthly checkpoint: a dot, or a triangle pointing up (ahead) or down (behind)
// — a shape as well as a colour, because this red and green look alike to
// red-green colour-blind readers. Months still to come are hollow. A 2px white
// ring keeps markers clear of the lines they sit on.
function drawMarker(ctx, x, y, { color, shape = 'dot', hollow = false, r = 4 }) {
  const path = () => {
    ctx.beginPath();
    if (shape === 'dot') {
      ctx.arc(x, y, r, 0, Math.PI * 2);
    } else {
      const s = r + 1.5;
      const tip = shape === 'up' ? -1 : 1;
      ctx.moveTo(x - s, y - tip * s * 0.7);
      ctx.lineTo(x + s, y - tip * s * 0.7);
      ctx.lineTo(x, y + tip * s);
      ctx.closePath();
    }
  };
  ctx.setLineDash([]);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = chartInk.markerSurface;
  path();
  ctx.stroke();
  ctx.fillStyle = hollow ? chartInk.markerSurface : color;
  path();
  ctx.fill();
  if (hollow) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    path();
    ctx.stroke();
  }
}

// Joins consecutive points; a null breaks the line. Each piece takes the colour
// for the side of its reference line it is on — split exactly where it crosses —
// and is dashed where it runs into a month that has not come yet.
function strokeSeries(ctx, frame, points, colorFor) {
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const piece = (a, b, excess, dashed) => {
    ctx.strokeStyle = colorFor(excess);
    ctx.setLineDash(dashed ? [6, 5] : []);
    ctx.beginPath();
    ctx.moveTo(a.x, frame.yAt(a.value));
    ctx.lineTo(b.x, frame.yAt(b.value));
    ctx.stroke();
  };
  points.forEach((b, k) => {
    const a = points[k - 1];
    if (!a || !b) return;
    if ((a.excess >= 0) === (b.excess >= 0)) {
      piece(a, b, a.excess, b.upcoming);
      return;
    }
    const f = a.excess / (a.excess - b.excess);
    const cross = { x: a.x + f * (b.x - a.x), value: a.value + f * (b.value - a.value) };
    piece(a, cross, a.excess, b.upcoming);
    piece(cross, b, b.excess, b.upcoming);
  });
  ctx.setLineDash([]);
}

function drawLegendKey(ctx, item, x, y) {
  ctx.strokeStyle = item.color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.setLineDash(item.dash || []);
  ctx.beginPath();
  ctx.moveTo(x + 1, y);
  ctx.lineTo(x + 15, y);
  ctx.stroke();
  ctx.setLineDash([]);
  if (item.marker) drawMarker(ctx, x + 8, y, { color: item.color, shape: item.marker, r: 3.5 });
}

// The fewest months a chart can be zoomed in to.
const minZoomSlots = 3;

function clampZoomWidth(width, count) {
  return Math.min(count, Math.max(Math.min(minZoomSlots, count), width));
}

// The months in view, as a window [start, end) over the month slots; a null
// view is the whole year.
function clampView(view, count) {
  if (!view) return { start: 0, end: count, full: true };
  const width = clampZoomWidth(view.end - view.start, count);
  const start = Math.min(Math.max(0, view.start), count - width);
  return { start, end: start + width, full: width >= count };
}

// chart: { labels, valuesAt(i) (the figures month i plots), legend, bonus?,
// emptyText, drawMarks(ctx, frame, hoverIndex), tooltip(i) }. Draws the frame
// for the months in view and records the geometry on the canvas so the hover and
// zoom layers can map a pointer back to a month.
function drawMonthChart(canvas, chart, hoverIndex = -1) {
  const { ctx, w, h } = prepareCanvas(canvas);
  const { labels } = chart;
  const count = Math.max(labels.length, 1);
  const view = clampView(canvas.chartView, count);
  ctx.font = chartFont;
  ctx.textBaseline = 'middle';

  // The whole year sits on a zero baseline. Zoomed in, the axis fits the months
  // in view — plus the one just past each edge, so a line leaving the plot is not
  // cut off — the way a trading chart does. A year with nothing to plot keeps just
  // the zero line and says so.
  const allValues = labels.flatMap((_, i) => chart.valuesAt(i));
  const hasData = allValues.some((value) => value !== 0);
  const first = Math.max(0, Math.floor(view.start - 0.5));
  const last = Math.min(labels.length - 1, Math.ceil(view.end - 0.5));
  const viewValues = view.full ? allValues : labels.slice(first, last + 1).flatMap((_, k) => chart.valuesAt(first + k));
  const scale = niceScale(viewValues.length ? viewValues : allValues, h < 340 ? 4 : 5, view.full)
    || { min: 0, max: 1, step: 1 };
  const ticks = hasData
    ? Array.from({ length: Math.round((scale.max - scale.min) / scale.step) + 1 }, (_, k) => scale.min + k * scale.step)
    : [0];
  const plotLeft = Math.ceil(Math.max(...ticks.map((value) => ctx.measureText(chartYen(value)).width))) + 14;
  const plotRight = w - 10;

  // Lay the legend out first: it wraps on a narrow canvas and pushes the plot down.
  const legendRows = [[]];
  let legendX = plotLeft;
  chart.legend.forEach((item) => {
    const width = 22 + ctx.measureText(item.label).width;
    if (legendX > plotLeft && legendX + width > plotRight) {
      legendRows.push([]);
      legendX = plotLeft;
    }
    legendRows[legendRows.length - 1].push({ ...item, x: legendX });
    legendX += width + 18;
  });
  const plotTop = 12 + legendRows.length * 20 + 12;
  const plotBottom = h - 30;
  const slot = (plotRight - plotLeft) / (view.end - view.start);
  const frame = {
    slot,
    plotTop,
    plotBottom,
    plotLeft,
    plotRight,
    xAt: (i) => plotLeft + slot * (i + 0.5 - view.start),
    yAt: (value) => plotBottom - (value - scale.min) / (scale.max - scale.min) * (plotBottom - plotTop)
  };
  // Everything drawn for a month is kept inside the plot, so zoomed-in lines run
  // off its edges instead of over the axis labels.
  const clipToPlot = (top, bottom) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, top, plotRight - plotLeft, bottom - top);
    ctx.clip();
  };

  // Bands sit behind everything: bonus columns always, the hovered month on top.
  const band = (i, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(frame.xAt(i) - slot / 2 + 2, plotTop - 6, slot - 4, plotBottom - plotTop + 30);
  };
  clipToPlot(0, h);
  labels.forEach((label, i) => { if (chart.bonus?.[i]) band(i, chartInk.bonus); });
  if (hoverIndex >= 0) band(hoverIndex, chartInk.hover);
  ctx.restore();

  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ticks.forEach((value) => {
    const y = Math.round(frame.yAt(value)) + 0.5;
    ctx.strokeStyle = Math.abs(value) < scale.step / 1000 ? chartInk.baseline : chartInk.grid;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
    ctx.fillStyle = chartInk.muted;
    ctx.fillText(chartYen(value), plotLeft - 10, y);
  });

  // Trading-chart style vertical time divisions make month-to-month movement
  // easier to scan without adding visual weight to the data series.
  ctx.strokeStyle = chartInk.grid;
  labels.forEach((label, i) => {
    const x = Math.round(frame.xAt(i)) + 0.5;
    if (x < plotLeft || x > plotRight) return;
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
  });

  if (!hasData) {
    ctx.textAlign = 'center';
    ctx.fillStyle = chartInk.muted;
    ctx.fillText(chart.emptyText, (plotLeft + plotRight) / 2, (plotTop + plotBottom) / 2);
  }
  clipToPlot(plotTop - 14, plotBottom + 14);
  chart.drawMarks(ctx, frame, hoverIndex);
  ctx.restore();

  // Month names fit on a desktop; a phone gets initials rather than tilted text.
  // Only months whose centre is in view are labelled.
  ctx.font = chartFont;
  ctx.textAlign = 'center';
  ctx.fillStyle = chartInk.muted;
  const shown = labels
    .map((label, i) => ({ text: String(label).slice(0, 6), x: frame.xAt(i) }))
    .filter(({ x }) => x >= plotLeft - 0.5 && x <= plotRight + 0.5);
  const widths = shown.map(({ text }) => ctx.measureText(text).width);
  const roomy = widths.every((width, k) => k === 0 || (width + widths[k - 1]) / 2 + 6 <= slot);
  shown.forEach(({ text, x }) => {
    ctx.fillText(roomy ? text : text.charAt(0).toUpperCase(), x, plotBottom + 15);
  });

  ctx.textAlign = 'left';
  legendRows.forEach((row, rowIndex) => row.forEach((item) => {
    const y = 18 + rowIndex * 20;
    drawLegendKey(ctx, item, item.x, y);
    ctx.fillStyle = chartInk.text;
    ctx.fillText(item.label, item.x + 22, y);
  }));

  canvas.classList.toggle('is-zoomed', !view.full);
  canvas.chartModel = {
    chart,
    hoverIndex,
    count,
    view,
    slot,
    plotLeft,
    plotWidth: plotRight - plotLeft,
    // Where x falls in slot units, e.g. 2.5 is the middle of the third month.
    slotPosition: (x) => view.start + (x - plotLeft) / slot,
    slotAt: (x) => {
      if (x < plotLeft || x > plotRight) return -1;
      const i = Math.floor(view.start + (x - plotLeft) / slot);
      return i >= 0 && i < labels.length ? i : -1;
    },
    slotCenter: frame.xAt
  };
}

function salaryChart(year) {
  const source = (state.salary || []).filter((item) => Number(item.year) === year);
  const rows = source.map((item) => {
    const gross = Number(item.salary || 0);
    const takeHome = Number(item.takeHome || 0);
    return {
      label: item.month,
      gross,
      takeHome,
      // How far take-home sits above (or below) its floor share of gross.
      excess: takeHome - gross * takeHomeFloor,
      bonus: isBonusMonth(item.month),
      upcoming: !monthHasElapsed(item, year, source),
      hasFigures: gross !== 0 || takeHome !== 0
    };
  });
  const figures = rows.filter((row) => row.hasFigures);
  const floorLabel = `${takeHomeFloor * 100}%`;
  const legend = [{ label: 'Gross income', color: chartInk.gross, marker: 'dot' }];
  if (figures.some((row) => row.excess >= 0)) legend.push({ label: 'Take-home', color: chartInk.good, marker: 'dot' });
  if (figures.some((row) => row.excess < 0)) {
    legend.push({ label: `Take-home below ${floorLabel} of gross`, color: chartInk.below, marker: 'down' });
  }
  if (figures.some((row) => row.upcoming)) legend.push({ label: 'Upcoming', color: chartInk.upcoming, dash: [4, 3] });
  const status = (excess) => (excess >= 0 ? chartInk.good : chartInk.below);
  return {
    labels: rows.map((row) => row.label),
    valuesAt: (i) => (rows[i].hasFigures ? [rows[i].gross, rows[i].takeHome] : []),
    bonus: rows.map((row) => row.bonus),
    legend,
    emptyText: `No salary figures for ${year} yet`,
    // The lines run through every column in the order it was paid, bonuses
    // included, so each dot sits on its line; the shaded column is what marks a
    // bonus. A month with no figures at all breaks the line rather than dropping
    // it to zero.
    drawMarks(ctx, frame, hoverIndex) {
      const columns = rows.map((row, i) => ({ ...row, x: frame.xAt(i) }));
      const line = (key) => columns.map((row) => (row.hasFigures
        ? { x: row.x, value: row[key], excess: key === 'takeHome' ? row.excess : 0, upcoming: row.upcoming }
        : null));
      strokeSeries(ctx, frame, line('gross'), () => chartInk.gross);
      strokeSeries(ctx, frame, line('takeHome'), status);
      rows.forEach((row, i) => {
        if (!row.hasFigures) return;
        const x = frame.xAt(i);
        const r = i === hoverIndex ? 5 : 4;
        drawMarker(ctx, x, frame.yAt(row.gross), { color: chartInk.gross, hollow: row.upcoming, r });
        drawMarker(ctx, x, frame.yAt(row.takeHome), {
          color: status(row.excess), shape: row.excess < 0 ? 'down' : 'dot', hollow: row.upcoming, r
        });
      });
    },
    tooltip(i) {
      const row = rows[i];
      const share = row.gross > 0 ? Math.round(row.takeHome / row.gross * 100) : null;
      return {
        title: `${row.label} ${year}${row.upcoming ? ' · projected' : ''}`,
        rows: [
          { value: yen(row.takeHome), label: 'Take-home', color: status(row.excess), dashed: row.upcoming },
          { value: yen(row.gross), label: 'Gross income', color: chartInk.gross, dashed: row.upcoming }
        ],
        note: share === null ? '' : `Take-home is ${share}% of gross${row.excess < 0 ? `, below ${floorLabel}` : ''}`
      };
    }
  };
}

function stockChart(year) {
  const source = normalizeStockYear(year);
  const rows = source.map((item) => {
    const hasTarget = item.targetCumulative !== 0;
    return {
      label: item.month,
      target: item.targetCumulative,
      actual: item.actualCumulative,
      // Without a target there is nothing to fall short of.
      excess: hasTarget ? item.actualCumulative - item.targetCumulative : 0,
      hasTarget,
      hasActual: stockHasActual(item),
      upcoming: !monthHasElapsed(item, year, source)
    };
  });
  const measured = rows.filter((row) => row.hasActual);
  const legend = [{ label: 'Target', color: chartInk.target, marker: 'dot' }];
  if (measured.some((row) => row.excess >= 0)) legend.push({ label: 'On or above target', color: chartInk.good, marker: 'up' });
  if (measured.some((row) => row.excess < 0)) legend.push({ label: 'Below target', color: chartInk.below, marker: 'down' });
  if (rows.some((row) => row.upcoming && row.hasTarget)) legend.push({ label: 'Upcoming', color: chartInk.upcoming, dash: [4, 3] });
  const status = (excess) => (excess >= 0 ? chartInk.good : chartInk.below);
  return {
    labels: rows.map((row) => row.label),
    valuesAt: (i) => [...(rows[i].hasTarget ? [rows[i].target] : []), ...(rows[i].hasActual ? [rows[i].actual] : [])],
    legend,
    emptyText: `No stock figures for ${year} yet`,
    // Running totals read best as lines. Actual is green while it is on or above
    // the target line and red while below it, and the gap between the two is
    // shaded to match — each split where the lines cross.
    drawMarks(ctx, frame, hoverIndex) {
      const shade = (points, ahead) => {
        ctx.fillStyle = ahead ? chartInk.goodWash : chartInk.belowWash;
        ctx.beginPath();
        points.forEach(([x, value], k) => (k ? ctx.lineTo(x, frame.yAt(value)) : ctx.moveTo(x, frame.yAt(value))));
        ctx.closePath();
        ctx.fill();
      };
      rows.slice(1).forEach((b, k) => {
        const a = rows[k];
        if (!a.hasActual || !b.hasActual || !a.hasTarget || !b.hasTarget) return;
        const [x0, x1] = [frame.xAt(k), frame.xAt(k + 1)];
        if (a.excess * b.excess >= 0) {
          if (a.excess || b.excess) shade([[x0, a.actual], [x1, b.actual], [x1, b.target], [x0, a.target]], a.excess + b.excess > 0);
          return;
        }
        const f = a.excess / (a.excess - b.excess);
        const cross = [x0 + f * (x1 - x0), a.actual + f * (b.actual - a.actual)];
        shade([[x0, a.actual], cross, [x0, a.target]], a.excess > 0);
        shade([cross, [x1, b.actual], [x1, b.target]], b.excess > 0);
      });
      const line = (has, key) => rows.map((row, i) => (has(row)
        ? { x: frame.xAt(i), value: row[key], excess: key === 'actual' ? row.excess : 0, upcoming: row.upcoming }
        : null));
      strokeSeries(ctx, frame, line((row) => row.hasTarget, 'target'), () => chartInk.target);
      strokeSeries(ctx, frame, line((row) => row.hasActual, 'actual'), status);
      rows.forEach((row, i) => {
        const x = frame.xAt(i);
        const r = i === hoverIndex ? 5 : 4;
        if (row.hasTarget) drawMarker(ctx, x, frame.yAt(row.target), { color: chartInk.target, hollow: row.upcoming, r });
        if (!row.hasActual) return;
        drawMarker(ctx, x, frame.yAt(row.actual), {
          color: status(row.excess), shape: row.excess < 0 ? 'down' : 'up', hollow: row.upcoming, r
        });
      });
      // Name the latest figure at the end of the line — it is the Win Total —
      // while that month is in view.
      const last = rows.findLastIndex((row) => row.hasActual);
      if (last < 0) return;
      const [x, y] = [frame.xAt(last), frame.yAt(rows[last].actual)];
      if (x < frame.plotLeft || x > frame.plotRight) return;
      const text = chartYen(rows[last].actual);
      ctx.font = `600 ${chartFont}`;
      const width = ctx.measureText(text).width;
      const fitsRight = x + 10 + width <= frame.plotRight;
      ctx.textAlign = fitsRight ? 'left' : 'center';
      const [labelX, labelY] = fitsRight ? [x + 10, y] : [Math.min(x, frame.plotRight - 2 - width / 2), y - 16];
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      // The halo hides the lines behind the label, so it wears the chart's own
      // surface colour - white here turned the label into a smear on dark.
      ctx.strokeStyle = chartInk.markerSurface;
      ctx.strokeText(text, labelX, labelY);
      ctx.fillStyle = chartInk.text;
      ctx.fillText(text, labelX, labelY);
    },
    tooltip(i) {
      const row = rows[i];
      const note = !row.hasActual ? 'No actual figure yet'
        : !row.hasTarget ? ''
        : row.excess > 0 ? `${yen(row.excess)} above target`
        : row.excess < 0 ? `${yen(-row.excess)} below target`
        : 'On target';
      return {
        title: `${row.label} ${year}${row.upcoming ? ' · upcoming' : ''}`,
        rows: [
          row.hasActual && { value: yen(row.actual), label: 'Actual', color: status(row.excess), dashed: row.upcoming },
          row.hasTarget && { value: yen(row.target), label: 'Target', color: chartInk.target, dashed: row.upcoming }
        ].filter(Boolean),
        note
      };
    }
  };
}

function activeChartCanvas() {
  return document.getElementById(activeChart === 'stock' ? 'stockChart' : 'salaryChart');
}

function renderCharts() {
  const year = currentYear();
  const canvas = activeChartCanvas();
  // Another year is another set of months: start again from the whole year.
  if (canvas.chartYear !== year) canvas.chartView = null;
  canvas.chartYear = year;
  hideChartTooltip();
  drawMonthChart(canvas, activeChart === 'stock' ? stockChart(year) : salaryChart(year));
  updateZoomControls();
}

function updateZoomControls() {
  const model = activeChartCanvas().chartModel;
  const zoomed = Boolean(model && !model.view.full);
  document.getElementById('chartZoomReset').hidden = !zoomed;
  document.getElementById('chartZoomOut').disabled = !zoomed;
  document.getElementById('chartZoomIn').disabled = !model
    || model.view.end - model.view.start <= clampZoomWidth(0, model.count);
}

// Shows `width` months from `start` and redraws. A window that reaches both ends
// is the whole year again.
function setChartView(canvas, start, width) {
  const model = canvas.chartModel;
  if (!model) return;
  const view = clampView({ start, end: start + width }, model.count);
  canvas.chartView = view.end - view.start >= model.count - 1e-6 ? null : view;
  drawMonthChart(canvas, model.chart, -1);
  chartTooltipFor(canvas).hidden = true;
  updateZoomControls();
}

// A factor under 1 zooms in and over 1 zooms out, keeping the month under x (or
// the middle of the view) where it is.
function zoomChart(canvas, factor, x) {
  const model = canvas.chartModel;
  if (!model) return;
  const { start, end } = model.view;
  const width = end - start;
  const next = clampZoomWidth(width * factor, model.count);
  const anchor = x === undefined ? start + width / 2 : model.slotPosition(x);
  setChartView(canvas, anchor - (anchor - start) * (next / width), next);
}

function resetChartZoom(canvas) {
  if (!canvas.chartModel) return;
  setChartView(canvas, 0, canvas.chartModel.count);
}

// One tooltip per chart panel. Values lead and labels follow; everything goes in
// through textContent because month labels are typed by the user.
function chartTooltipFor(canvas) {
  let tip = canvas.parentElement.querySelector('.chart-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tooltip';
    tip.hidden = true;
    canvas.parentElement.append(tip);
  }
  return tip;
}

function hideChartTooltip() {
  document.querySelectorAll('.chart-tooltip').forEach((tip) => { tip.hidden = true; });
}

// Pinned beside the hovered month, at the pointer's height.
function showChartTooltip(canvas, index, pointerY) {
  const model = canvas.chartModel;
  const tip = chartTooltipFor(canvas);
  if (tip.hidden || tip.dataset.index !== String(index)) fillChartTooltip(tip, model.chart.tooltip(index));
  tip.dataset.index = String(index);
  tip.hidden = false;
  const x = canvas.offsetLeft + model.slotCenter(index);
  const panel = canvas.parentElement;
  const fitsRight = x + 16 + tip.offsetWidth <= panel.clientWidth;
  const left = fitsRight ? x + 16 : x - 16 - tip.offsetWidth;
  const top = canvas.offsetTop + pointerY - tip.offsetHeight / 2;
  tip.style.left = `${Math.max(0, Math.min(left, panel.clientWidth - tip.offsetWidth))}px`;
  tip.style.top = `${Math.max(0, Math.min(top, panel.clientHeight - tip.offsetHeight))}px`;
}

function fillChartTooltip(tip, content) {
  const title = document.createElement('strong');
  title.textContent = content.title;
  const lines = content.rows.map((row) => {
    const line = document.createElement('div');
    line.className = 'chart-tooltip-row';
    const key = document.createElement('i');
    key.className = row.dashed ? 'dashed' : '';
    key.style.color = row.color;
    const value = document.createElement('b');
    value.textContent = row.value;
    const label = document.createElement('span');
    label.textContent = row.label;
    line.append(key, value, label);
    return line;
  });
  tip.replaceChildren(title, ...lines);
  if (content.note) {
    const note = document.createElement('small');
    note.textContent = content.note;
    tip.append(note);
  }
}

// Hover or tap a month for its figures. And, like a trading chart: scroll or
// pinch to zoom around the pointer, drag sideways to move along the year, and
// double-click to see the whole year again.
function bindChartInteraction(canvas) {
  const pointers = new Map();
  let drag = null;
  let pinch = null;
  const localX = (clientX) => clientX - canvas.getBoundingClientRect().left;
  const hover = (event) => {
    const model = canvas.chartModel;
    if (!model) return;
    const rect = canvas.getBoundingClientRect();
    const index = model.slotAt(event.clientX - rect.left);
    if (index !== model.hoverIndex) drawMonthChart(canvas, model.chart, index);
    if (index < 0) chartTooltipFor(canvas).hidden = true;
    else showChartTooltip(canvas, index, event.clientY - rect.top);
  };
  const clear = () => {
    const model = canvas.chartModel;
    // The canvas on the hidden tab has no size to redraw at; it redraws when shown.
    if (model?.hoverIndex >= 0 && canvas.getClientRects().length) drawMonthChart(canvas, model.chart, -1);
    chartTooltipFor(canvas).hidden = true;
  };
  const twoFingers = () => {
    const [a, b] = [...pointers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: localX((a.x + b.x) / 2) };
  };

  canvas.addEventListener('pointerdown', (event) => {
    const model = canvas.chartModel;
    if (!model || (event.pointerType === 'mouse' && event.button !== 0)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const { distance, mid } = twoFingers();
      pinch = { distance, width: model.view.end - model.view.start, anchor: model.slotPosition(mid) };
      drag = null;
      chartTooltipFor(canvas).hidden = true;
      return;
    }
    drag = { x: event.clientX, start: model.view.start, slot: model.slot, moved: false };
    canvas.setPointerCapture(event.pointerId);
    hover(event);
  });

  canvas.addEventListener('pointermove', (event) => {
    const model = canvas.chartModel;
    if (!model) return;
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size === 2) {
      const { distance, mid } = twoFingers();
      const width = clampZoomWidth(pinch.width * pinch.distance / distance, model.count);
      setChartView(canvas, pinch.anchor - (mid - model.plotLeft) * width / model.plotWidth, width);
      return;
    }
    // Once zoomed in, a press that moves sideways drags the months along.
    if (drag && pointers.has(event.pointerId) && !model.view.full) {
      const dx = event.clientX - drag.x;
      if (drag.moved || Math.abs(dx) > 4) {
        drag.moved = true;
        canvas.classList.add('is-panning');
        setChartView(canvas, drag.start - dx / drag.slot, model.view.end - model.view.start);
        return;
      }
    }
    hover(event);
  });

  const release = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) {
      drag = null;
      canvas.classList.remove('is-panning');
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('dblclick', () => resetChartZoom(canvas));

  canvas.addEventListener('wheel', (event) => {
    const model = canvas.chartModel;
    if (!model) return;
    const unit = event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 400 : 1;
    const [dx, dy] = [event.deltaX * unit, event.deltaY * unit];
    const zoomKey = event.ctrlKey || event.metaKey;
    if (!zoomKey && Math.abs(dx) > Math.abs(dy)) {
      if (model.view.full) return;
      event.preventDefault();
      setChartView(canvas, model.view.start + dx / model.slot, model.view.end - model.view.start);
      return;
    }
    // Where the page itself scrolls (the stacked layout), a plain wheel keeps
    // scrolling it; Ctrl/⌘ + scroll or a trackpad pinch zooms there instead.
    if (!zoomKey && window.matchMedia('(max-width: 980px)').matches) return;
    event.preventDefault();
    zoomChart(canvas, Math.exp(dy * (zoomKey ? 0.01 : 0.0015)), localX(event.clientX));
    hover(event);
  }, { passive: false });

  // A finger lifting off counts as leaving, so on touch the tooltip stays up
  // until the next tap somewhere else.
  canvas.addEventListener('pointerleave', (event) => { if (event.pointerType !== 'touch' && !drag) clear(); });
  document.addEventListener('pointerdown', (event) => { if (event.target !== canvas) clear(); });
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
  renderKpis();
  renderCharts();
}

function renderDashboard() {
  fillSelect('dashboardYear', selectableYears(state.salary || []), currentYear());
  renderKpis();
  renderCharts();
}

function formatValue(key, value) {
  if (['salary', 'takeHome', 'plannedSavings', 'expenseTotal', 'actualSavings', 'cumulativeCapital', 'basic', 'allowance', 'overtimePay', 'transportation', 'grossTotal', 'insurance', 'pension', 'employmentInsurance', 'residentTax', 'incomeTax', 'totalDeduction', 'received', 'targetCumulative', 'actualCumulative', 'monthlyRevenue', 'surplus', 'amount', 'rate'].includes(key)) {
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
    <tr class="${rowClass(item)}" data-record-id="${escapeHtml(item.id)}" data-record-collection="${escapeHtml(collection)}">
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
  const records = sortRecordsByMonth(selected ? salaryRecords.filter((item) => String(item.year) === String(selected)) : salaryRecords);
  renderTable('salaryTable', 'salary', schemas.salary, records, {
    rowClass: (item) => monthHasElapsed(item, item.year, records) ? '' : 'row-projected',
    canDelete: (item) => !item.derivedFromDetail,
    deleteHint: 'This row is generated from Salary Details. Delete the matching salary detail instead.'
  });
}

function renderExpenses() {
  const year = selectedExpenseYear();
  const month = selectedExpenseMonth();
  fillSelect('expenseYearFilter', selectableYears(state.expenses), year);
  fillSelectPairs('expenseMonthFilter', [['', 'All months'], ...monthOptions], month);
  const yearRecords = (state.expenses || [])
    .filter((item) => Number(item.year) === Number(year));
  const records = yearRecords
    .filter((item) => !month || normalizeMonth(item.month) === month)
    .sort((a, b) => monthIndex(a.month) - monthIndex(b.month) || Number(a.day || 0) - Number(b.day || 0));
  const selectedTotal = sum(records, 'amount');
  const annualTotal = sum(yearRecords, 'amount');
  document.getElementById('expenseSummary').innerHTML = `
    <div><span>${month ? `${escapeHtml(month)} total` : 'Selected total'}</span><strong>${yen(selectedTotal)}</strong></div>
    <div><span>${year} annual total</span><strong>${yen(annualTotal)}</strong></div>
    <div><span>Expense items</span><strong>${records.length}</strong></div>`;
  renderTable('expenseTable', 'expenses', schemas.expenses, records);
}

function renderDetails() {
  const years = yearsFrom(state.monthlyDetails);
  const selected = document.getElementById('detailsYearFilter').value || years[years.length - 1] || '';
  fillSelect('detailsYearFilter', selectableYears(state.monthlyDetails), selected, 'All years');
  const records = sortRecordsByMonth(selected ? state.monthlyDetails.filter((item) => String(item.year) === String(selected)) : state.monthlyDetails);
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
  renderTable('overtimeTable', 'overtime', schemas.overtime, recordsForMonth);
}

function renderStocks() {
  const selected = selectedStockYear();
  fillSelect('stockYearFilter', selectableYears(state.stockRevenue), selected);
  const records = normalizeStockYear(selected);
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
      <tr data-stock-row-year="${year}" data-stock-row-month="${escapeHtml(month)}"${item.id ? ` data-record-id="${escapeHtml(item.id)}"` : ''}>
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
  const records = selected ? recordsForYear.filter((item) => item.month === selected) : recordsForYear;
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
  renderTable('balanceTable', 'personalBalances', schemas.personalBalances, state.personalBalances);
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
  document.getElementById('accountDataText').textContent = accountUser
    ? `${accountUser.email || accountUser.displayName || 'Signed in'}${cloudSyncEnabled ? ' · syncing' : ''}`
    : 'Local only';
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
  expenses: renderExpenses,
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
  const computed = new Set([
    ...(computedFields[collection] || []),
    ...(collection === 'salary' && record?.derivedFromDetail ? ['salary', 'takeHome'] : [])
  ]);
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
  if (collection === 'salary' || collection === 'expenses') values.month = normalizeMonth(values.month);
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

async function exportBackupData() {
  const output = await window.financeApi.exportBackup(state);
  if (output) setSaveState(`Backup exported: ${output}`);
}

async function exportWorkbook() {
  const output = await window.financeApi.exportExcel(state);
  if (output) setSaveState(`Exported: ${output}`);
}

async function importWorkbookWithConfirmation() {
  if (hasRecords() && !confirm('Importing a workbook will replace the current records. Continue?')) return;
  try {
    const imported = await window.financeApi.importExcel();
    if (!imported) return;
    state = imported;
    render();
    if (cloudSyncEnabled) await save();
    setSaveState('Workbook imported');
  } catch (error) {
    console.error(error);
    setSaveState('Import failed');
    alert(error?.message || 'That workbook could not be read.');
  }
}

async function importExcelWithConfirmation() {
  if (hasRecords() && !confirm('Importing a backup will replace the current records. Continue?')) return;
  try {
    const imported = await window.financeApi.importBackup();
    if (imported) {
      state = imported;
      state.salarySheets = state.salarySheets || [];
      state.unpaidBills = state.unpaidBills || [];
      render();
      if (cloudSyncEnabled) await save();
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
  let record = preferredStockRecord(stockRecordsFor(year, month), month);
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

// Demo data is invented here in code, never loaded from a file, so no real record
// can find its way into it. (A seed file built from real records used to be
// published alongside the app.)
async function buildDemoData() {
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
  const expenses = [
    ['Jan', 6, 'Rent', 78000], ['Jan', 12, 'Groceries', 18500],
    ['Feb', 6, 'Rent', 78000], ['Feb', 18, 'Utilities', 11200],
    ['Mar', 6, 'Rent', 78000], ['Mar', 21, 'Transport', 9400]
  ].map(([month, day, category, amount]) => ({
    id: id('expenses'), year, month, day, category, amount, note: ''
  }));
  const salary = monthlyDetails.map((detail, index) => {
    const expenseTotal = sum(expenses.filter((item) => item.month === detail.month), 'amount');
    const actualSavings = detail.received - expenseTotal;
    return {
      id: id('salary'),
      year,
      month: detail.month,
      salary: detail.grossTotal,
      takeHome: detail.received,
      plannedSavings: 120000,
      expenseTotal,
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
    expenses,
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
    expenses: [],
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
  next.meta = { ...browserEmptyData().meta, ...(data?.meta || {}) };
  [...collections, 'salarySheets', 'unpaidBills'].forEach((collection) => {
    const records = Array.isArray(next[collection]) ? next[collection] : [];
    next[collection] = records
      .filter((record) => record && typeof record === 'object' && !Array.isArray(record))
      .map((record) => (record.id ? record : { ...record, id: id(collection) }));
  });
  next.salary = next.salary.map((record) => ({
    ...record,
    takeHome: Number(record.takeHome ?? record.actualSavings ?? 0)
  }));
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

const backupVersion = 1;

// Move archived file bytes out of the records and into _archives.
function withDetachedArchives(data) {
  const next = { ...data };
  const archives = {};
  ['salarySheets', 'unpaidBills'].forEach((collection) => {
    const records = next[collection] || [];
    archives[collection] = records
      .filter((item) => typeof item.dataUrl === 'string' && item.dataUrl.includes(','))
      .map((item) => ({
        storedName: item.storedName,
        contentBase64: item.dataUrl.slice(item.dataUrl.indexOf(',') + 1)
      }));
    next[collection] = records.map(({ dataUrl, ...rest }) => rest);
  });
  next._archives = archives;
  return next;
}

function checkBackupVersion(data) {
  const version = Number(data?.meta?.version || 0);
  if (version > backupVersion) {
    throw new Error(`That backup was written by a newer version of the app (format ${version}). Update before importing it.`);
  }
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

async function loadStoredData(recordKey = currentStorageRecordKey) {
  try {
    const data = await idbGet(recordKey);
    if (data) return normalizeLoadedData(data);
    const legacy = recordKey === dbRecordKey ? localStorage.getItem(storageKey) : null;
    if (legacy) {
      const migrated = normalizeLoadedData(JSON.parse(legacy));
      await idbSet(recordKey, migrated);
      localStorage.removeItem(storageKey);
      return migrated;
    }
  } catch (error) {
    const raw = recordKey === dbRecordKey ? localStorage.getItem(storageKey) : null;
    if (raw) return normalizeLoadedData(JSON.parse(raw));
  }
  return browserEmptyData();
}

async function saveStoredData(data, recordKey = currentStorageRecordKey) {
  const next = normalizeLoadedData(data);
  next.meta.updatedAt = new Date().toISOString();
  try {
    await idbSet(recordKey, next);
    if (recordKey === dbRecordKey) localStorage.removeItem(storageKey);
  } catch (error) {
    if (recordKey !== dbRecordKey) {
      throw new Error('Could not save this account on this device. Export a JSON backup now.');
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch (fallbackError) {
      throw new Error('Could not save: this browser\'s storage is full or unavailable. Export a JSON backup now.');
    }
  }
  return next;
}

async function clearStoredData(recordKey = currentStorageRecordKey) {
  try {
    await idbDelete(recordKey);
  } catch (error) {
    // localStorage fallback below still clears usable data.
  }
  if (recordKey === dbRecordKey) localStorage.removeItem(storageKey);
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
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.opacity = '0';
    document.body.appendChild(input);

    let settled = false;
    const finish = (files) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };

    input.addEventListener('change', () => finish(Array.from(input.files || [])), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    input.click();
  });
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
  async importBackup() {
    const [file] = await chooseFiles({ accept: '.json,application/json' });
    if (!file) return null;
    const imported = JSON.parse(await readFileAsText(file));
    if (!looksLikeBackup(imported)) {
      throw new Error(`"${file.name}" is not a Finance Records backup, so nothing was imported.`);
    }
    checkBackupVersion(imported);
    const data = normalizeLoadedData(imported);
    data.meta.sourceFile = file.name;
    data.meta.importedAt = new Date().toISOString();
    data.meta.startedAt = data.meta.startedAt || data.meta.importedAt;
    return saveStoredData(data);
  },
  async exportBackup(data) {
    const next = normalizeLoadedData(data);
    next.meta.updatedAt = new Date().toISOString();
    next.meta.version = backupVersion;
    const filename = `FinanceRecords-Backup-${new Date().toISOString().slice(0, 10)}.json`;
    downloadText(filename, JSON.stringify(withDetachedArchives(next), null, 2));
    return filename;
  },

  async exportExcel(data) {
    const XLSX = await import('xlsx');
    const next = normalizeLoadedData(data);
    const workbook = XLSX.utils.book_new();
    const addSheet = (name, rows, widths) => {
      const sheet = XLSX.utils.json_to_sheet(rows);
      if (widths) sheet['!cols'] = widths;
      if (rows.length) sheet['!freeze'] = { xSplit: 0, ySplit: 1 };
      XLSX.utils.book_append_sheet(workbook, sheet, name);
    };

    // A Summary sheet first, so the workbook opens on the same figures as the app.
    const years = yearsFrom(next.salary);
    addSheet('Summary', years.map((year) => {
      const rows = (next.salary || []).filter((item) => Number(item.year) === year);
      const elapsed = rows.filter((item) => monthHasElapsed(item, year, rows));
      const yearExpenses = (next.expenses || []).filter((item) => Number(item.year) === year);
      const elapsedExpenses = yearExpenses.filter((item) => monthHasElapsed(item, year, yearExpenses));
      const takeHome = sum(elapsed, 'takeHome');
      const expenditureTotal = sum(elapsedExpenses, 'amount');
      const stock = (next.stockRevenue || [])
        .filter((item) => Number(item.year) === year && Number(item.actualCumulative || 0) !== 0)
        .sort((a, b) => monthIndex(a.month) - monthIndex(b.month)).at(-1);
      return {
        'Year': year,
        'Gross Income (so far)': sum(elapsed, 'salary'),
        'Gross Income (full year)': sum(rows, 'salary'),
        'Take-home (so far)': takeHome,
        'Expenditures (so far)': expenditureTotal,
        'Savings (so far)': calculateSavings(takeHome, expenditureTotal),
        'Savings Goal (so far)': sum(elapsed, 'plannedSavings'),
        'Stock Win Total': Number(stock?.actualCumulative || 0),
        'Daily Stock Entries': (next.daily || []).filter((item) => Number(item.year) === year && Number(item.amount) !== 0).length
      };
    }), [{ wch: 8 }, { wch: 20 }, { wch: 22 }, { wch: 20 }, { wch: 23 }, { wch: 20 }, { wch: 16 }, { wch: 18 }]);

    workbookSheets.forEach(([sheetName, collection, fieldsFor]) => {
      const fields = fieldsFor();
      const rows = (next[collection] || []).map((record) =>
        Object.fromEntries(fields.map(([key, label]) => [label, record[key] ?? '']))
      );
      addSheet(sheetName, rows, fields.map(([, label]) => ({ wch: Math.max(12, label.length + 3) })));
    });
    const filename = `FinanceRecords-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    downloadBlob(filename, new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }));
    return filename;
  },

  async importExcel() {
    const [file] = await chooseFiles({ accept: '.xlsx,.xls' });
    if (!file) return null;
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(await file.arrayBuffer(), { cellDates: true });
    const imported = {
      meta: { version: 1, sourceFile: file.name, importedAt: new Date().toISOString() }
    };
    // Read back the sheets this app writes, mapping the column headings to fields.
    workbookSheets.forEach(([sheetName, collection, fieldsFor]) => {
      const ws = workbook.Sheets[sheetName];
      if (!ws) { imported[collection] = []; return; }
      const fields = fieldsFor();
      imported[collection] = XLSX.utils.sheet_to_json(ws).map((row) => {
        const record = {};
        fields.forEach(([key, label, type]) => {
          const value = row[label];
          if (value === undefined || value === '') return;
          record[key] = type === 'number' ? Number(value) : value;
        });
        return record;
      });
    });
    if (!looksLikeBackup(imported) || !collections.some((key) => imported[key].length)) {
      throw new Error(`"${file.name}" has no Finance Records sheets in it, so nothing was imported.`);
    }
    const data = normalizeLoadedData(imported);
    data.meta.startedAt = data.meta.startedAt || data.meta.importedAt;
    return saveStoredData(data);
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
  await save();
  setSaveState(cloudSyncEnabled ? 'Cleared and synced' : 'Cleared');
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
  ['salaryChart', 'stockChart'].forEach((id) => bindChartInteraction(document.getElementById(id)));
  document.getElementById('chartZoomIn').addEventListener('click', () => zoomChart(activeChartCanvas(), 1 / 1.5));
  document.getElementById('chartZoomOut').addEventListener('click', () => zoomChart(activeChartCanvas(), 1.5));
  document.getElementById('chartZoomReset').addEventListener('click', () => {
    resetChartZoom(activeChartCanvas());
    // The button hides once the whole year is back; keep focus in the toolbar.
    document.getElementById('chartZoomIn').focus();
  });
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
  // On narrow screens the app stays within the viewport and navigation becomes
  // a drawer. The floating control remains reachable from every section.
  const nav = document.getElementById('nav');
  const sidebar = document.getElementById('mobileSidebar');
  const backToMenu = document.getElementById('backToMenu');
  const menuBackdrop = document.getElementById('mobileMenuBackdrop');
  const topbar = document.querySelector('.topbar');
  const mobileSearchToggle = document.getElementById('mobileSearchToggle');
  const narrowLayout = window.matchMedia('(max-width: 980px)');

  const setMobileSearchOpen = (open) => {
    const isOpen = narrowLayout.matches && open;
    topbar.classList.toggle('mobile-search-open', isOpen);
    mobileSearchToggle.setAttribute('aria-expanded', String(isOpen));
    mobileSearchToggle.setAttribute('aria-label', isOpen ? 'Close search' : 'Open search');
    if (isOpen) requestAnimationFrame(() => document.getElementById('globalSearch').focus());
  };

  const setMobileMenuOpen = (open) => {
    const isOpen = narrowLayout.matches && open;
    if (isOpen) setMobileSearchOpen(false);
    sidebar.classList.toggle('mobile-open', isOpen);
    document.body.classList.toggle('mobile-menu-open', isOpen);
    sidebar.setAttribute('aria-hidden', narrowLayout.matches && !isOpen ? 'true' : 'false');
    backToMenu.setAttribute('aria-expanded', String(isOpen));
    backToMenu.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
    if (isOpen) nav.querySelector('button.active')?.focus({ preventScroll: true });
  };

  const syncMobileMenuLayout = () => {
    backToMenu.hidden = !narrowLayout.matches;
    mobileSearchToggle.hidden = !narrowLayout.matches;
    if (narrowLayout.matches) {
      setMobileMenuOpen(false);
      setMobileSearchOpen(false);
    } else {
      sidebar.classList.remove('mobile-open');
      document.body.classList.remove('mobile-menu-open');
      sidebar.removeAttribute('aria-hidden');
    }
  };

  backToMenu.addEventListener('click', () => {
    setMobileMenuOpen(!sidebar.classList.contains('mobile-open'));
  });
  mobileSearchToggle.addEventListener('click', () => {
    const willOpen = !topbar.classList.contains('mobile-search-open');
    if (willOpen) setMobileMenuOpen(false);
    setMobileSearchOpen(willOpen);
  });
  menuBackdrop.addEventListener('click', () => {
    setMobileMenuOpen(false);
    backToMenu.focus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (sidebar.classList.contains('mobile-open')) {
      setMobileMenuOpen(false);
      backToMenu.focus();
    } else if (topbar.classList.contains('mobile-search-open')) {
      setMobileSearchOpen(false);
      mobileSearchToggle.focus();
    }
  });
  narrowLayout.addEventListener('change', syncMobileMenuLayout);
  syncMobileMenuLayout();
  document.getElementById('nav').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (!button) return;
    switchView(button.dataset.view);
    setMobileMenuOpen(false);
    if (narrowLayout.matches) backToMenu.focus();
  });
  document.body.addEventListener('click', (event) => {
    const searchResult = event.target.closest('[data-search-result]');
    if (searchResult) {
      openGlobalSearchResult(Number(searchResult.dataset.searchResult));
      setMobileSearchOpen(false);
      return;
    }
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
  ['dashboardYear', 'salaryYearFilter', 'detailsYearFilter', 'stockYearFilter', 'dailyYearFilter', 'dailyMonthFilter', 'expenseYearFilter', 'expenseMonthFilter', 'otYearFilter', 'otMonthFilter'].forEach((idName) => {
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
  document.getElementById('themeButton').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme || 'ocean';
    applyTheme(themeOrder[(themeOrder.indexOf(current) + 1) % themeOrder.length]);
  });
  document.getElementById('setupSignIn').addEventListener('click', beginGoogleSignIn);
  document.getElementById('accountSignIn').addEventListener('click', beginGoogleSignIn);
  document.getElementById('accountSyncNow').addEventListener('click', syncAccountNow);
  document.getElementById('accountSignOut').addEventListener('click', async () => {
    setSaveState('Signing out...');
    try {
      const { signOutAccount } = await firebaseClient();
      await signOutAccount();
    } catch (error) {
      console.error(error);
      setSaveState('Sign out failed');
    }
  });
  const searchInput = document.getElementById('globalSearch');
  const searchResults = document.getElementById('globalSearchResults');
  const debouncedSearch = debounce(renderGlobalSearch, 180);
  document.getElementById('globalSearchForm').addEventListener('submit', (event) => {
    event.preventDefault();
    renderGlobalSearch();
  });
  searchInput.addEventListener('input', debouncedSearch);
  searchInput.addEventListener('focus', () => {
    if (searchText()) renderGlobalSearch();
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      renderGlobalSearch();
      return;
    }
    if (event.key === 'Escape') {
      closeGlobalSearch();
      return;
    }
    if (event.key === 'ArrowDown' && !searchResults.hidden) {
      const firstResult = searchResults.querySelector('.search-result-item');
      if (firstResult) {
        event.preventDefault();
        firstResult.focus();
      }
    }
  });
  searchResults.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeGlobalSearch();
    searchInput.focus();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.search-shell')) closeGlobalSearch();
  });
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
  document.getElementById('dataImportExcel').addEventListener('click', importWorkbookWithConfirmation);
  document.getElementById('sidebarImportBackup').addEventListener('click', importExcelWithConfirmation);
  document.getElementById('sidebarExportBackup').addEventListener('click', exportBackupData);
  document.getElementById('sidebarImportExcel').addEventListener('click', importWorkbookWithConfirmation);
  document.getElementById('sidebarExportExcel').addEventListener('click', exportWorkbook);
  document.getElementById('dataImportBackup').addEventListener('click', importExcelWithConfirmation);
  document.getElementById('dataExportBackup').addEventListener('click', exportBackupData);
  document.getElementById('setupLoadDemoData').addEventListener('click', loadDemoData);
  document.getElementById('startBlank').addEventListener('click', async () => {
    state = await window.financeApi.startBlank();
    render();
    if (cloudSyncEnabled) await save();
    setSaveState(cloudSyncEnabled ? 'Started and synced' : 'Started');
  });
  document.getElementById('dataExportExcel').addEventListener('click', exportWorkbook);
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
  window.addEventListener('online', () => {
    if (cloudSyncEnabled && state.meta?.cloudPending) syncAccountNow();
  });
  window.addEventListener('offline', () => {
    if (cloudSyncEnabled) updateAccountUI('Offline · changes stay on this device');
  });
}

async function init() {
  applyTheme(preferredTheme(), false);
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
  updateAccountUI();
  updateSaveButton();
  switchView('dashboard');
  if (document.getElementById('saveState').textContent === 'Loading...') {
    setSaveState('Ready');
  }
  try {
    const { initializeAccountSession } = await firebaseClient();
    await initializeAccountSession((user) => {
      if (user) {
        activateAccount(user);
      } else if (accountUser) {
        activateLocalMode();
      } else {
        updateAccountUI();
      }
    });
  } catch (error) {
    console.error(error);
    updateAccountUI('Account service unavailable · local mode');
  }
}

init();
