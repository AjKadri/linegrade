// Sliding-window rate limit, in memory. One limiter instance per rule; keys are session ids or client IPs.

// `max` may be a number or a function (read on every request, so the limit can be changed without a restart).
function rateLimiter({ name, windowMs = 60_000, max, keyFn, now = () => Date.now() }) {
  const hits = new Map();
  let calls = 0;
  return (req, res, next) => {
    const t = now();
    const key = keyFn(req);
    let arr = hits.get(key);
    if (!arr) { arr = []; hits.set(key, arr); }
    while (arr.length && t - arr[0] > windowMs) arr.shift();
    const limit = typeof max === 'function' ? max() : max;
    if (arr.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (t - arr[0])) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `Too many requests from this ${name}. Wait ${retryAfter} seconds and try again.`, code: 'RATE_LIMIT', cap: name, retryAfter });
    }
    arr.push(t);
    if (++calls % 500 === 0) for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] > windowMs) hits.delete(k); // forget idle keys
    return next();
  };
}

module.exports = { rateLimiter };
