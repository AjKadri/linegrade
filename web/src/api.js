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

// Is the server up? Resolves with the status JSON, rejects with a short reason a person can read.
// The path is /api/status, not /health: some ad and privacy blockers block any URL called "health" (the request then fails
// at once with a TypeError, ERR_BLOCKED_BY_CLIENT). Uses AbortController + setTimeout (older Safari lacks AbortSignal.timeout).
async function status() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const t0 = Date.now();
  try {
    const r = await fetch('/api/status', { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) throw new Error(`the server answered HTTP ${r.status}`);
    let j; try { j = await r.json(); } catch { throw new Error('the reply was not the app (a loading page?)'); }
    if (!j || j.status !== 'ok') throw new Error('the server did not report ok');
    return j;
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? 'no answer within 8 seconds' : e.name === 'TypeError' ? 'could not connect to the server (network error)' : (e.message || String(e)));
    err.blockedSignature = e.name === 'TypeError' && Date.now() - t0 < 1000; // fast network error: what a blocked request looks like
    throw err;
  } finally { clearTimeout(timer); }
}

// The wake check must never lock anybody out of a working app. If the status probe fails the way a blocked request does,
// ask the app's own data endpoint: if that answers, the server is up (the probe was blocked, not the server asleep).
async function reachable() {
  try { return await status(); } catch (e) {
    if (!e.blockedSignature) throw e;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch('/api/state', { cache: 'no-store', signal: ctrl.signal });
      if (r.ok) return { status: 'ok', via: 'data' };
    } catch { /* the data request failed too: really down */ } finally { clearTimeout(timer); }
    throw e;
  }
}

export const api = {
  health: reachable,
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
