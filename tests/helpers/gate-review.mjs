/**
 * The criteria confirmations a gate review schema asks for (fake reviewers): one row per id of
 * `schema.properties.criteria`, met unless listed in `unmet`. Empty for any other review schema.
 * @param {any} schema
 * @param {{ unmet?: string[] }} [options]
 */
export function confirmedCriteria(schema, { unmet = [], lesson = null } = {}) {
  if (!schema?.properties?.criteria) return {};
  const ids = schema.properties.criteria.items?.properties?.id?.enum ?? [];
  return {
    criteria: ids.map(id => ({ id, met: !unmet.includes(id), evidence: `Fixture review checked ${id}` })),
    ...(schema.properties.lesson ? { lesson } : {}),
  };
}
