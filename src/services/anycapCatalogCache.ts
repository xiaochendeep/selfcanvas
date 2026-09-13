/** Share discovery requests without allowing an obsolete failure to evict a refresh. */
export function createCatalogRequestCache<T>(loader: (endpoint: string, refresh: boolean) => Promise<T>, now = Date.now) {
  const cache = new Map<string, { expires: number; value: Promise<T> }>();
  return (endpoint = '', refresh = false): Promise<T> => {
    const key = endpoint.trim();
    const cached = cache.get(key);
    if (!refresh && cached && cached.expires > now()) return cached.value;
    const value = Promise.resolve().then(() => loader(key, refresh)).catch((error: unknown) => {
      if (cache.get(key)?.value === value) cache.delete(key);
      throw error;
    });
    cache.set(key, { expires: now() + 5 * 60 * 1000, value });
    return value;
  };
}
