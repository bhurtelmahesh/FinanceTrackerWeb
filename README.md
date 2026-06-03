# Finance Tracker Web

Browser-first version of Finance Tracker.

## Features

- Dashboard with savings, stock win, debt, and income KPIs
- Salary and monthly detail records
- Daily overtime entry and payroll-style summary
- Stock win target grid
- Month/day daily records grid
- Debt records and unpaid bill archive
- Demo data, clear-all flow, and JSON backup import/export

## Run Locally

```bash
npm install
npm run dev
```

Data is stored locally in browser-private IndexedDB storage, with a localStorage fallback for older browsers. Export a JSON backup before clearing browser data or switching devices.
