// What a loaded file needs before the app can use it. Backups go back to before
// expenditures existed and before take-home had a field of its own, so this is
// where an old file is brought up to date - and where the guarantee that it
// still opens is tested, rather than only by importing one by hand.

// Backups written by the desktop app keep file bytes in `_archives` instead of an
// inline dataUrl. Rehydrate them so archived files are actually openable.
export function rehydrateArchives(data) {
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

// Move archived file bytes out of the records and into _archives.
export function withDetachedArchives(data) {
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

// `empty` is the app's own blank shape, so a collection this file predates - the
// expenditures of a 2026-06 backup, say - arrives as an empty list rather than
// undefined. `makeId` names any record saved before ids were kept.
export function migrateLoadedData(data, { empty, collections, makeId }) {
  const next = rehydrateArchives({ ...empty, ...(data || {}) });
  next.meta = { ...empty.meta, ...(data?.meta || {}) };
  collections.forEach((collection) => {
    const records = Array.isArray(next[collection]) ? next[collection] : [];
    next[collection] = records
      .filter((record) => record && typeof record === 'object' && !Array.isArray(record))
      .map((record) => (record.id ? record : { ...record, id: makeId(collection) }));
  });
  // Take-home used to be called actualSavings, back when nothing was deducted
  // from it. Savings are now take-home minus expenditures, so the old figure
  // becomes the take-home it always was and savings are recalculated from it.
  next.salary = next.salary.map((record) => ({
    ...record,
    takeHome: Number(record.takeHome ?? record.actualSavings ?? 0)
  }));
  return next;
}
