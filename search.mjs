const fullMonthNames = {
  jan: 'january', feb: 'february', mar: 'march', apr: 'april', may: 'may', jun: 'june',
  jul: 'july', aug: 'august', sep: 'september', oct: 'october', nov: 'november', dec: 'december'
};

export function normalizeSearchText(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
}

function searchableValue(key, value) {
  const text = normalizeSearchText(value);
  if (key !== 'month') return text;
  const shortMonth = text.slice(0, 3);
  return `${text} ${fullMonthNames[shortMonth] || ''}`.trim();
}

function compactNumberText(value) {
  return normalizeSearchText(value).replace(/[¥￥$,\s]/g, '');
}

function tokenMatches(token, text, compactText) {
  if (text.includes(token)) return true;
  const compactToken = compactNumberText(token);
  return /\d/.test(compactToken) && compactToken !== token && compactText.includes(compactToken);
}

export function searchRecords(sections, rawQuery, maxResults = 60) {
  const query = normalizeSearchText(rawQuery);
  const tokens = query.split(/\s+/).filter(Boolean);
  if (!tokens.length) return { matches: [], total: 0 };

  const allMatches = [];
  (sections || []).forEach((section) => {
    const sectionText = normalizeSearchText([section.label, ...(section.keywords || [])].join(' '));
    (section.records || []).forEach((record) => {
      const fieldValues = (section.fields || []).map(([key, label]) => ({
        key,
        label,
        value: record?.[key],
        text: searchableValue(key, record?.[key])
      }));
      const recordText = `${sectionText} ${fieldValues.map(({ text }) => text).join(' ')}`;
      const compactRecordText = compactNumberText(recordText);
      if (!tokens.every((token) => tokenMatches(token, recordText, compactRecordText))) return;

      const matchingFields = fieldValues
        .filter(({ text }) => {
          const compactText = compactNumberText(text);
          return tokens.some((token) => tokenMatches(token, text, compactText));
        })
        .map(({ key, label, value }) => ({ key, label, value }));
      allMatches.push({ section, record, matchingFields });
    });
  });

  return {
    matches: allMatches.slice(0, Math.max(0, maxResults)),
    total: allMatches.length
  };
}
