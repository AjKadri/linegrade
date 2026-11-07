// Thin client for the Express API. Credentials and the test card never reach the browser.
async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  state: () => call('GET', '/api/state'),
  catalog: () => call('GET', '/api/catalog'),
  reset: () => call('POST', '/api/catalog/reset'),
  approve: (body) => call('POST', '/api/review/approve', body),
  exclude: (sku) => call('POST', '/api/review/exclude', { sku }),
  unapprove: (sku) => call('POST', '/api/review/unapprove', { sku }),
  codes: (q) => call('GET', `/api/codes?q=${encodeURIComponent(q)}`),
  preview: (order) => call('POST', '/api/order/preview', order),
  pay: (order) => call('POST', '/api/order/pay', order),
  readiness: () => call('GET', '/api/readiness'),
};

// Live AI re-run (server-sent events). Returns a function that closes the stream.
export function streamEnrich({ force }, on) {
  const es = new EventSource(`/api/enrich/stream${force ? '?force=1' : ''}`);
  for (const ev of ['plan', 'item', 'done']) es.addEventListener(ev, (e) => on[ev]?.(JSON.parse(e.data)));
  es.addEventListener('error', (e) => {
    // Server-sent "error" events carry data; plain connection errors do not.
    const msg = e.data ? JSON.parse(e.data).message : 'Connection to the server was lost, or too many AI re-runs this hour.';
    on.error?.(msg);
    es.close();
  });
  es.addEventListener('done', () => es.close());
  return () => es.close();
}
