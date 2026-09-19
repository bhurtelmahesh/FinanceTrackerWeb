// The app's month vocabulary. Records carry months as text - "Jan", "january",
// "1", "Bonus" - so every comparison goes through here, and the rules are worth
// testing on their own rather than only through the page.

export const monthOptions = [
  ['Jan', 'Jan'], ['Feb', 'Feb'], ['Mar', 'Mar'], ['Apr', 'Apr'], ['May', 'May'], ['Jun', 'Jun'],
  ['Jul', 'Jul'], ['Aug', 'Aug'], ['Sep', 'Sep'], ['Oct', 'Oct'], ['Nov', 'Nov'], ['Dec', 'Dec']
];

export const fullMonthNames = {
  january: 'Jan', february: 'Feb', march: 'Mar', april: 'Apr', may: 'May', june: 'Jun', july: 'Jul',
  august: 'Aug', september: 'Sep', october: 'Oct', november: 'Nov', december: 'Dec'
};

export function monthIndex(month) {
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

export function normalizeMonth(month) {
  const lower = String(month || '').trim().toLowerCase();
  const fullName = fullMonthNames[lower];
  if (fullName) return fullName;
  const prefixed = monthOptions.find(([key]) => lower.startsWith(key.toLowerCase()));
  if (prefixed) return prefixed[0];
  const idx = monthIndex(month);
  return idx ? monthOptions[idx - 1][0] : String(month || '');
}

export function isBonusMonth(month) {
  return /bonus|賞与|ボーナス/i.test(String(month || ''));
}

// Whether a month has happened is a calendar question. A bonus counts from the
// month it is paid in: June for the year's first, December for any later one - the
// order sortRecordsByMonth files them in. `records` is the list the row came from,
// which says which of the year's bonuses it is.
export function monthHasElapsed(record, year, records, now = new Date()) {
  let monthNumber = monthIndex(record.month);
  if (isBonusMonth(record.month)) {
    const bonuses = (records || []).filter((item) =>
      Number(item.year) === Number(year) && isBonusMonth(item.month));
    monthNumber = bonuses.indexOf(record) > 0 ? 12 : 6;
  }
  if (!monthNumber) return true;
  if (Number(year) !== now.getFullYear()) return Number(year) < now.getFullYear();
  return monthNumber <= now.getMonth() + 1;
}
