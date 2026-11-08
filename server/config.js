// Operating limits. Read from the environment on every call so tests (and an operator) can change them.
// Nothing here is a secret. Secrets (LLM_API_KEY, BT_*) are only ever read from the environment, never the repo.

const num = (name, dflt) => {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

function config() {
  return {
    // Live AI (the "re-run AI" button). Off if LIVE_AI=off/0/false, or if there is no LLM key.
    liveAiFlag: !['off', '0', 'false', 'no'].includes(String(process.env.LIVE_AI || '').toLowerCase()),
    hasLlmKey: !!process.env.LLM_API_KEY && !!process.env.LLM_MODEL,
    dailyCapUsd: num('LLM_DAILY_CAP_USD', 2),
    maxRerunsSession: num('MAX_RERUNS_PER_SESSION', 2),
    maxRerunsDay: num('MAX_RERUNS_PER_DAY', 30),
    maxPaymentsSession: num('MAX_PAYMENTS_PER_SESSION', 5),
    maxPaymentsDay: num('MAX_PAYMENTS_PER_DAY', 200),
    ratePerSessionPerMin: num('RATE_LIMIT_SESSION_PER_MIN', 180),
    ratePerIpPerMin: num('RATE_LIMIT_IP_PER_MIN', 600),
    sessionIdleMs: num('SESSION_IDLE_MIN', 120) * 60_000,
    maxSessions: num('MAX_SESSIONS', 500),
    adminToken: process.env.ADMIN_TOKEN || '',
  };
}

module.exports = { config };
