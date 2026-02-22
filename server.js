const express = require('express');
const cron = require('node-cron');
const https = require('https');
const app = express();
app.use(express.json());

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
let SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_TOKEN || null;
let SHOPIFY_STORE = 'dx3yfb-ru.myshopify.com';
const EVOLARI_SYNC_VARIANT_ID = 52855103750449;
const PORT = process.env.PORT || 3000;

function shopifyRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SHOPIFY_STORE,
      path: `/admin/api/2024-10${path}`,
      method,
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function exchangeToken(shop, code) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code
    });
    console.log('[OAUTH] Exchanging code for token on shop:', shop);
    console.log('[OAUTH] Using API key:', SHOPIFY_API_KEY);
    const options = {
      hostname: shop,
      path: '/admin/oauth/access_token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        console.log('[OAUTH] Token response:', d);
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('Parse error: ' + d)); }
      });
    });
    req.on('error', (e) => { console.log('[OAUTH] Request error:', e.message); reject(e); });
    req.write(body);
    req.end();
  });
}

app.get('/', async (req, res) => {
  console.log('[ROOT] Query params:', JSON.stringify(req.query));
  const { shop, code } = req.query;

  if (shop && code) {
    try {
      const tokenData = await exchangeToken(shop, code);
      if (tokenData.access_token) {
        SHOPIFY_ACCESS_TOKEN = tokenData.access_token;
        SHOPIFY_STORE = shop;
        console.log('[OAUTH] ✓ SUCCESS! Token:', tokenData.access_token, 'Store:', shop);
        res.send(`<h1>Connected!</h1><p>Store: ${shop}</p><p>Token: <strong>${tokenData.access_token}</strong></p><p>Add this as SHOPIFY_TOKEN in Railway Variables!</p>`);
      } else {
        console.log('[OAUTH] No access_token in response:', JSON.stringify(tokenData));
        res.send('Failed: ' + JSON.stringify(tokenData));
      }
    } catch (err) {
      console.error('[OAUTH] Error:', err.message);
      res.send('Error: ' + err.message);
    }
  } else {
    res.json({ status: 'Evolari Renewal Server running', time: new Date().toISOString(), token_loaded: !!SHOPIFY_ACCESS_TOKEN, store: SHOPIFY_STORE });
  }
});

app.get('/test-renew', async (req, res) => {
  if (!SHOPIFY_ACCESS_TOKEN) return res.json({ success: false, error: 'No token. Visit / after installing app.' });
  console.log('[TEST] Triggered. Store:', SHOPIFY_STORE);
  try {
    const data = await shopifyRequest('GET', '/orders.json?tag=evolari-subscription&status=any&limit=250');
    console.log('[DEBUG]', JSON.stringify(data).substring(0, 300));
    const orders = data.orders || [];
    res.json({ success: true, store: SHOPIFY_STORE, subscription_orders_found: orders.length, orders: orders.map(o => ({ order_number: o.order_number, customer_email: o.email, tags: o.tags })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/renew', async (req, res) => {
  if (!SHOPIFY_ACCESS_TOKEN) return res.json({ success: false, error: 'No token' });
  try {
    const data = await shopifyRequest('GET', '/orders.json?tag=evolari-subscription&status=any&limit=250');
    const orders = data.orders || [];
    if (!orders.length) return res.json({ success: true, renewed: 0 });
    const results = [];
    for (const order of orders) {
      const customerId = order.customer?.id;
      const customerEmail = order.email;
      if (!customerId) continue;
      const result = await shopifyRequest('POST', '/orders.json', {
        order: { customer: { id: customerId }, email: customerEmail, line_items: [{ variant_id: EVOLARI_SYNC_VARIANT_ID, quantity: 1 }], gateway: 'manual', financial_status: 'pending', tags: 'evolari-sync-renewal,auto-generated', note: 'Auto-generated renewal - Evolari Sync 30-day cycle' }
      });
      if (result.order) {
        console.log(`[RENEWAL] ✓ #${result.order.order_number} for ${customerEmail}`);
        results.push({ customer: customerEmail, orderNumber: result.order.order_number });
      } else {
        console.log(`[RENEWAL] ✗ Failed:`, JSON.stringify(result.errors));
      }
    }
    res.json({ success: true, renewed: results.length, orders: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

cron.schedule('0 9 */30 * *', async () => {
  if (!SHOPIFY_ACCESS_TOKEN) { console.log('[CRON] No token, skipping'); return; }
  console.log('[CRON] Triggered at', new Date().toISOString());
  try {
    const data = await shopifyRequest('GET', '/orders.json?tag=evolari-subscription&status=any&limit=250');
    const orders = data.orders || [];
    if (!orders.length) { console.log('[CRON] No orders due'); return; }
    for (const order of orders) {
      const customerId = order.customer?.id;
      const customerEmail = order.email;
      if (!customerId) continue;
      const result = await shopifyRequest('POST', '/orders.json', {
        order: { customer: { id: customerId }, email: customerEmail, line_items: [{ variant_id: EVOLARI_SYNC_VARIANT_ID, quantity: 1 }], gateway: 'manual', financial_status: 'pending', tags: 'evolari-sync-renewal,auto-generated' }
      });
      if (result.order) console.log(`[CRON] ✓ #${result.order.order_number} for ${customerEmail}`);
    }
  } catch (err) { console.error('[CRON] Error:', err.message); }
});

console.log('[CRON] Scheduler active');
app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));
