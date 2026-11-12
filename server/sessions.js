// Per-browser sessions. A cookie (lg_sid, HttpOnly, SameSite=Lax) carries a random id; each session has its own
// directory under data/sessions/<id>/ holding its catalog copy and ledger, plus its own counters. One browser's
// actions never appear in another's. Idle sessions expire after SESSION_IDLE_MIN (default 120) and are deleted.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE = 'lg_sid';
const ID_RE = /^[A-Za-z0-9_-]{24}$/;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

class SessionManager {
  /** @param {{dir: string, idleMs?: number, maxSessions?: number, now?: () => number}} o */
  constructor({ dir, idleMs = 7_200_000, maxSessions = 500, now = () => Date.now() }) {
    this.dir = dir; this.idleMs = idleMs; this.maxSessions = maxSessions; this.now = now;
    this.sessions = new Map();
    this.replaced = new Map(); // stale cookie id -> the session that replaced it (60 s), so concurrent requests agree
  }

  /** Start clean: delete every session directory left by an earlier run. */
  clearAll() {
    this.sessions.clear();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  create() {
    this.sweep();
    while (this.sessions.size >= this.maxSessions) {
      // Over capacity: drop the session that has been idle longest.
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      this.destroy(oldest.id);
    }
    const id = crypto.randomBytes(18).toString('base64url'); // 24 chars
    const t = this.now();
    const s = { id, dir: path.join(this.dir, id), created: t, lastSeen: t, start: new Date(t).toISOString(), reruns: 0, aiRuns: 0, payments: 0 };
    this.sessions.set(id, s);
    return s;
  }

  /** The live session for an id, or null if unknown or idle for too long (which also deletes it). */
  get(id) {
    if (!ID_RE.test(String(id || ''))) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (this.now() - s.lastSeen > this.idleMs) { this.destroy(id); return null; }
    return s;
  }

  touch(s) { s.lastSeen = this.now(); }

  destroy(id) {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    if (s && ID_RE.test(id)) fs.rmSync(s.dir, { recursive: true, force: true });
  }

  sweep() {
    const t = this.now();
    let n = 0;
    for (const s of [...this.sessions.values()]) if (t - s.lastSeen > this.idleMs) { this.destroy(s.id); n++; }
    return n;
  }

  count() { return this.sessions.size; }

  /** Express middleware: attaches req.session; reissues the cookie (sliding expiry). */
  middleware() {
    return (req, res, next) => {
      const presented = parseCookies(req.headers.cookie)[COOKIE];
      let s = this.get(presented);
      req.sessionExpired = false;
      if (!s && presented) {
        // A cookie we no longer know (expired, or the server restarted). Several requests can arrive carrying the same stale
        // cookie before the browser has stored the new one: they all join the ONE replacement session, and only the
        // first answer carries the "expired" flag.
        const t = this.now();
        for (const [k, v] of this.replaced) if (t - v.t > 60_000) this.replaced.delete(k);
        const known = this.replaced.get(presented);
        s = known ? this.get(known.sid) : null;
        if (!s) { s = this.create(); this.replaced.set(presented, { sid: s.id, t }); req.sessionExpired = true; }
      }
      if (!s) s = this.create();
      this.touch(s);
      req.session = s;
      // The cookie outlives the idle limit on purpose: the SERVER decides when a session is over, so it can tell a
      // returning visitor "your session expired" instead of silently starting a new one.
      const maxAge = Math.max(86_400, Math.round((this.idleMs * 2) / 1000));
      res.append('Set-Cookie', `${COOKIE}=${s.id}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`);
      if (req.sessionExpired) res.set('X-LG-Session', 'expired');
      next();
    };
  }
}

module.exports = { SessionManager, parseCookies, COOKIE, ID_RE };
