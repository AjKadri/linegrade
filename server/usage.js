// Global daily usage (UTC day): LLM spend, live AI re-runs and sandbox payments. Persisted to a small JSON file
// so a restart on the same disk does not reset the cap (on Render's free tier the disk is ephemeral, so a
// restart or spin-down does reset it: the per-session caps and the OpenRouter key limit still apply).

const fs = require('node:fs');
const path = require('node:path');

class Usage {
  constructor(file, now = () => Date.now()) {
    this.file = file; this.now = now; this.state = null;
  }

  day() { return new Date(this.now()).toISOString().slice(0, 10); }

  load() {
    const today = this.day();
    if (!this.state) {
      try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.state = null; }
    }
    if (!this.state || this.state.day !== today) this.state = { day: today, spend_usd: 0, reruns: 0, payments: 0 };
    return this.state;
  }

  snapshot() { return { ...this.load() }; }

  add({ spend = 0, reruns = 0, payments = 0 } = {}) {
    const s = this.load();
    s.spend_usd = Math.round((s.spend_usd + spend) * 1e6) / 1e6;
    s.reruns += reruns; s.payments += payments;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(s)); } catch { /* best effort */ }
    return { ...s };
  }
}

module.exports = { Usage };
