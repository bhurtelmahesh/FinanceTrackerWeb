# Finance Tracker Web

Browser-first version of Finance Tracker.

## Features

- Dashboard with savings, stock win, debt, and income KPIs
- Salary and savings in one table, with each month's payslip breakdown beside it
- Daily overtime entry and payroll-style summary
- Stock win target grid
- Month/day daily records grid
- Expenditure records with monthly and annual totals
- Debt records and unpaid bill archive
- Ocean and Dark themes, remembered per device
- Demo data, clear-all flow, and JSON backup import/export

## Run Locally

```bash
npm install
npm run dev
```

The app works without an account using browser-private IndexedDB storage, with a localStorage fallback for older browsers. Optional Google sign-in syncs structured financial records through a private, per-user Cloud Firestore path. Signed-in records also keep a device cache for offline access. Archived salary sheets and bill files remain device-only and are included in JSON backups, not uploaded to Firebase.

## Account and cloud sync

- Google sign-in is optional; signing out returns to the untouched local profile.
- The first sign-in offers to copy existing local records to the account and never deletes the local source.
- Firestore rules default to deny and allow reads/writes only when the authenticated UID owns the path.
- JSON backup import/export remains available in both local and signed-in modes.
- Run `npm run test:rules` to verify signed-out, owner, cross-user, and schema rule behavior with the Firestore emulator.
