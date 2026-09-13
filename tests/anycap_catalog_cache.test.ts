import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogRequestCache } from '../src/services/anycapCatalogCache.ts';

test('same-endpoint concurrent requests are deduplicated and expired values refresh', async () => {
  let time = 0;
  let calls = 0;
  const fetchCatalog = createCatalogRequestCache(async (endpoint) => ({ endpoint, call: ++calls }), () => time);
  const first = fetchCatalog(' gateway ');
  assert.equal(fetchCatalog('gateway'), first);
  assert.equal((await first).call, 1);
  time = 300001;
  assert.equal((await fetchCatalog('gateway')).call, 2);
});

test('an obsolete failed request never removes the newer successful refresh', async () => {
  let rejectOld!: (reason: Error) => void;
  let calls = 0;
  const fetchCatalog = createCatalogRequestCache(async () => {
    calls += 1;
    if (calls === 1) return new Promise<string>((_resolve, reject) => { rejectOld = reject; });
    return 'new catalog';
  });
  const old = fetchCatalog('A');
  const oldRejected = assert.rejects(old, /old failed/);
  await Promise.resolve();
  const fresh = fetchCatalog('A', true);
  assert.equal(await fresh, 'new catalog');
  rejectOld(new Error('old failed'));
  await oldRejected;
  assert.equal(fetchCatalog('A'), fresh);
  assert.equal(calls, 2);
});

test('a failed current request is retriable and another endpoint stays isolated', async () => {
  let calls = 0;
  const fetchCatalog = createCatalogRequestCache(async (endpoint) => {
    if (++calls === 1) throw new Error('offline');
    return endpoint;
  });
  await assert.rejects(fetchCatalog('A'), /offline/);
  assert.equal(await fetchCatalog('B'), 'B');
  assert.equal(await fetchCatalog('A'), 'A');
  assert.equal(calls, 3);
});
