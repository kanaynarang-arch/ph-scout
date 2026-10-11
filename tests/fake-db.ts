// A tiny stand-in for Neon's cache_entries table, so the pipeline tests have a store to read and write.
// Any SQL it does not know (e.g. launch_seen) throws, like a database that is not answering.
interface Row { value: unknown; fetched_at: string; expires_at: string }
export const store = new Map<string, Row>();

export async function fakeQuery(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  if (text.includes("FROM cache_entries WHERE key = ANY")) {
    return (params[0] as string[]).filter((k) => store.has(k)).map((k) => ({ key: k, ...store.get(k)! }));
  }
  if (text.includes("unnest($1::text[], $2::text[], $3::text[])")) {
    const [keys, values, expires, fetched] = params as [string[], string[], string[], string];
    keys.forEach((k, i) => store.set(k, { value: JSON.parse(values[i]), fetched_at: fetched, expires_at: expires[i] }));
    return [];
  }
  if (text.includes("RETURNING key") && text.includes("'true'::jsonb")) {
    const [k, ttl] = params as [string, number];
    const cur = store.get(k);
    if (cur && Date.parse(cur.expires_at) >= Date.now()) return [];
    store.set(k, { value: true, fetched_at: new Date().toISOString(), expires_at: new Date(Date.now() + ttl).toISOString() });
    return [{ key: k }];
  }
  if (text.startsWith("DELETE FROM cache_entries WHERE key = $1")) {
    store.delete(params[0] as string);
    return [];
  }
  if (text.includes("SELECT expires_at FROM cache_entries WHERE key = $1")) {
    const cur = store.get(params[0] as string);
    return cur && Date.parse(cur.expires_at) > Date.now() ? [{ expires_at: cur.expires_at }] : [];
  }
  throw new Error("fake db: unsupported query");
}
