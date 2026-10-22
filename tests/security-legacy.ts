export function legacyRecords(state: Record<string, unknown[] | Record<string, unknown>>): Record<string, unknown> {
  const records: Record<string, unknown> = {};
  for (const [group, values] of Object.entries(state)) {
    if (Array.isArray(values)) for (const value of values as Record<string, unknown>[]) records[`sec:${group}:${encodeURIComponent(String(value.id ?? `${value.workspaceId}/${value.userId}`))}`] = { group, value };
    else for (const [id, value] of Object.entries(values)) records[`sec:${group}:${encodeURIComponent(id)}`] = { group, value };
  }
  return records;
}
