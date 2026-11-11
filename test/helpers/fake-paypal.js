// A local fake of the PayPal Orders v2 API (token, create, capture, get) with idempotent replay by PayPal-Request-Id.
// Modes (set on fake.mode): create = '500' | 'decline'; capture = '500'; echo = 'none' (GET omits supplementary_data).
const http = require('node:http');

const fake = { calls: [], mode: {}, orders: new Map(), byRequestId: new Map(), seq: 0 };
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const rid = req.headers['paypal-request-id'];
    fake.calls.push({ method: req.method, url: req.url, rid });
    const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json', 'paypal-debug-id': 'dbg-test' }); res.end(JSON.stringify(json)); };
    if (req.url === '/v1/oauth2/token') return send(200, { access_token: 'tok', expires_in: 3600 });
    if (rid && fake.byRequestId.has(rid)) return send(...fake.byRequestId.get(rid)); // idempotent replay, like PayPal
    const remember = (status, json) => { if (rid) fake.byRequestId.set(rid, [status, json]); send(status, json); };
    if (req.method === 'POST' && req.url === '/v2/checkout/orders') {
      if (fake.mode.create === '500') return send(500, { name: 'INTERNAL_SERVER_ERROR' });
      if (fake.mode.create === 'decline') return remember(422, { name: 'UNPROCESSABLE_ENTITY', message: 'declined', details: [{ issue: 'INSTRUMENT_DECLINED', description: 'The instrument presented was declined.' }] });
      const body = JSON.parse(raw);
      const id = `FAKE-ORDER-${++fake.seq}`;
      fake.orders.set(id, { id, status: 'APPROVED', body });
      return remember(201, { id, status: 'APPROVED' });
    }
    const cap = req.url.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/);
    if (cap) {
      if (fake.mode.capture === '500') return send(500, { name: 'INTERNAL_SERVER_ERROR' });
      const o = fake.orders.get(cap[1]); o.status = 'COMPLETED'; o.capture = { id: `FAKE-CAP-${o.id}`, status: 'COMPLETED' };
      return remember(201, { id: o.id, status: 'COMPLETED', purchase_units: [{ payments: { captures: [o.capture] } }] });
    }
    const get = req.url.match(/^\/v2\/checkout\/orders\/([^/]+)$/);
    if (get && req.method === 'GET') {
      const o = fake.orders.get(get[1]); const spu = o.body.purchase_units[0];
      const unit = { ...spu, payments: { captures: [o.capture] } };
      if (fake.mode.echo === 'none') delete unit.supplementary_data;
      return send(200, { id: o.id, status: o.status, purchase_units: [unit], payment_source: { card: { brand: 'VISA', last_digits: '1881', type: 'UNKNOWN' } } });
    }
    return send(404, { name: 'NOT_FOUND' });
  });
});

async function start() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}
module.exports = { fake, server, start };
