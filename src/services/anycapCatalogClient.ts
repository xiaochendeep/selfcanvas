import { browserApiFetch } from './browserSession';
import { parseAnyCapCatalog, type AnyCapCatalog } from './anycapCatalog';
import { createCatalogRequestCache } from './anycapCatalogCache';

export const fetchAnyCapCatalog = createCatalogRequestCache<AnyCapCatalog>((endpoint, refresh) =>
  browserApiFetch('/api/providers/anycap/capabilities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, refresh }),
  }).then(async (response) => {
    const payload = await response.json() as AnyCapCatalog & { error?: string };
    if (!response.ok) throw new Error(payload.error || '暂时无法同步 AnyCap 模型');
    return parseAnyCapCatalog(payload);
  }),
);
