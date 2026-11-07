// Local order ledger: one entry per orderId, so a re-run never creates a second sale.
//
// status: pending  -> written BEFORE the Braintree call
//         charged  -> sale accepted (transactionId stored)
//         failed   -> Braintree answered and refused: nothing was charged, retry is safe
//         unknown  -> no answer (network/timeout): must be reconciled against Braintree before retrying
//
// SYNTHETIC/sandbox only. File: data/ledger.json (gitignored).

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LEDGER = path.join(__dirname, '..', 'data', 'ledger.json');

function read(file = DEFAULT_LEDGER) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Ledger ${file} is unreadable (${e.message}). Fix or move it; refusing to guess.`);
  }
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file); // atomic replace
}

function get(orderId, file = DEFAULT_LEDGER) { return read(file)[orderId] || null; }

function set(orderId, patch, file = DEFAULT_LEDGER) {
  const data = read(file);
  data[orderId] = { ...(data[orderId] || {}), ...patch, updated_at: new Date().toISOString() };
  write(file, data);
  return data[orderId];
}

module.exports = { get, set, read, DEFAULT_LEDGER };
