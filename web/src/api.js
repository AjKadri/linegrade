// Thin client for the Express API. Credentials and the test card never reach the browser.
// Each browser has its own server-side session (an HttpOnly cookie): nothing here can see another browser's work.

export class ApiError extends Error {
  constructor(message, extra = {}) { super(message); this.name = 'ApiError'; Object.assign(this, extra); }
}

const emit = (name) => window.dispatchEvent(new CustomEvent(name));

function noteSession(res) {
  if (res.headers.get('x-lg-session') === 'expired') emit('lg:session-expired');
}

async function call(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    emit('lg:offline'); // network failure: the server may be asleep or restarting
    throw new ApiError('Cannot reach the server. It may be waking up or restarting: trying again.', { code: 'OFFLINE' });
  }
  noteSession(res);
  if ([502, 503, 504].includes(res.status)) {
    emit('lg:offline');
    throw new ApiError('The server is waking up or restarting: trying again.', { code: 'OFFLINE', status: res.status });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (HTTP ${res.status}).`, { status: res.status, code: data.code, cap: data.cap, field: data.field, retryAfter: data.retryAfter });
  return data;
}

export const api = {
  health: () => fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
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

// Live AI re-run (server-sent events, read with fetch so error bodies such as "cap reached" are readable).
// Handlers: plan, item, done, capped, fallback, error({message, code, cap}). Returns a function that stops the stream.
export function streamEnrich({ force }, on) {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(`/api/enrich/stream${force ? '?force=1' : ''}`, { signal: ctrl.signal });
      noteSession(res);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        on.error?.({ message: d.error || `The AI run could not start (HTTP ${res.status}).`, code: d.code, cap: d.cap });
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) on[ev]?.(JSON.parse(data));
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') on.error?.({ message: 'The connection to the server was lost during the AI run. Nothing was changed.', code: 'OFFLINE' });
    }
  })();
  return () => ctrl.abort();
}
