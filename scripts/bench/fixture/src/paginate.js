/** @template T @param {T[]} items @param {number} page @param {number} limit @returns {T[]} */
export function paginate(items, page, limit) {
  return items.slice(page * limit, (page + 1) * limit);
}
