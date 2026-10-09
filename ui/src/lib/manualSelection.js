/** Pure helpers for the Manual Selection page (kept separate so they are testable). */

export const entryId = (entry) => `${entry.provider}/${entry.model}`;

export function addEntry(list, entry) {
  return list.some((item) => entryId(item) === entryId(entry)) ? list : [...list, { provider: entry.provider, model: entry.model }];
}

export function removeEntry(list, index) {
  return list.filter((_, i) => i !== index);
}

/** Moves the item at `from` to position `to` (clamped); returns a new array. */
export function moveEntry(list, from, to) {
  if (from < 0 || from >= list.length) return list;
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (target === from) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

export function sameOrder(a, b) {
  return a.length === b.length && a.every((item, i) => entryId(item) === entryId(b[i]));
}

export function filterAvailable(available, query) {
  const q = String(query || "").trim().toLowerCase();
  return q ? available.filter((entry) => entryId(entry).toLowerCase().includes(q)) : available;
}
