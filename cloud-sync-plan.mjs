export function cloudRecordKey(collectionName, recordId) {
  return `${collectionName}/${String(recordId)}`;
}

export function cloudMetaOperation(data, updatedAt = new Date().toISOString()) {
  return {
    type: 'set',
    collectionName: 'app',
    recordId: 'meta',
    data: {
      version: Number(data.meta?.version || 1),
      startedAt: data.meta?.startedAt || '',
      importedAt: data.meta?.importedAt || '',
      sourceFile: data.meta?.sourceFile || '',
      updatedAt
    }
  };
}

export function planCloudChanges(collectionNames, data, baseline, toCloud) {
  const operations = [];
  const nextBaseline = new Map();

  collectionNames.forEach((collectionName) => {
    (data[collectionName] || []).forEach((source) => {
      const record = toCloud(collectionName, source);
      const key = cloudRecordKey(collectionName, record.id);
      const serialized = JSON.stringify(record);
      nextBaseline.set(key, serialized);
      if (baseline.get(key) === serialized) return;
      operations.push({ type: 'set', collectionName, recordId: record.id, data: record });
    });
  });

  baseline.forEach((_, key) => {
    if (nextBaseline.has(key)) return;
    const separator = key.indexOf('/');
    operations.push({
      type: 'delete',
      collectionName: key.slice(0, separator),
      recordId: key.slice(separator + 1)
    });
  });

  return { operations, nextBaseline };
}
