/**
 * Forget what a cache holds for anything that is no longer in `present`. A frame of live books lists every book that is on the map, so a
 * book left out of it is gone (switched off, or aged out of the feed), and its last column must not go on being drawn as if it were live.
 */
export function dropAbsent<V>(cache: Map<string, V>, present: Iterable<string>): void {
  const keep = new Set(present);
  for (const id of [...cache.keys()]) if (!keep.has(id)) cache.delete(id);
}
