const express = require('express');
const cron = require('node-cron');
const https = require('https');
const app = express();
app.use(express.json());

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
let SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_TOKEN || null;
let SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'evolari.myshopify.com';
const EVOLARI_SYNC_VARIANT_ID = 52855103750449;
const PORT = process.env.PORT || 3000;

function shopifyRequest(store, token, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: store,
      path: `/admin/api/2024-10${path}`,
      method,
      headers: {
        'X-Shopify-Access-Token': token,
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

// OAuth callback - captures access token when app is installed
app.get('/', async (req, res) => {
  const { shop, code } = req.query;

  if (shop && code) {
    console.log('[OAUTH] Received callback for shop:', shop);
    try {
      // Exchange code for access token
      const tokenData = await new Promise((resolve, reject) => {
        const body = JSON.stringify({
          client_id: SHOPIFY_API_KEY,
          client_secret: SHOPIFY_API_SECRET,
          code
        });
        const options = {
          hostname: shop,
          path: '/admin/oauth/access_token',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        };
        const req = https.request(options, (r) => {
          let d = '';
          r.on('data', chunk => d += chunk);
          r.on('end', () => resolve(JSON.parse(d)));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      if (tokenData.access_token) {
        SHOPIFY_ACCESS_TOKEN = tokenData.access_token;
        SHOPIFY_STORE = shop;
        console.log('[OAUTH] ✓ Got access token for', shop, ':', tokenData.access_token);
        res.send(`
          <h1>✓ Evolari Renewal Server Connected!</h1>
          <p>Store: ${shop}</p>
          <p>Access Token: <strong>${tokenData.access_token}</strong></p>
          <p><strong>Copy this token and add it as SHOPIFY_TOKEN in Railway Variables!</strong></p>
        `);
      } else {
        console.log('[OAUTH] Failed:', JSON.stringify(tokenData));
        res.send('OAuth failed: ' + JSON.stringify(tokenData));
      }
    } catch (err) {
      console.error('[OAUTH] Error:', err.message);
      res.send('Error: ' + err.message);
    }
  } else {
    res.json({ status: 'Evolari Renewal Server running', time: new Date().toISOString(), token_loaded: !!SHOPIFY_ACCESS_TOKEN });
  }
});

app.get('/test-renew', async (req, res) => {
  if (!SHOPIFY_ACCESS_TOKEN) return res.json({ success: false, error: 'No access token. Install the app first.' });
  console.log('[TEST] Triggered');
  try {
    const data = await shopifyRequest(SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN, 'GET', '/orders.json?tag=evolari-subscription&status=any&limit=250');
    console.log('[DEBUG]', JSON.stringify(data).substring(0, 300));
    const orders = data.orders || [];
    res.json({ success: true, subscription_orders_found: orders.length, orders: orders.map(o => ({ order_number: o.order_number, customer_email: o.email, tags: o.tags })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/renew', async (req, res) => {
  if (!SHOPIFY_ACCESS_TOKEN) return res.json({ success: false, error: 'No access token' });
  try {
    const data = await shopifyRequest(SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN, 'GET', '/orders.json?tag=evolari-subscription&status=any&limit=250');
    const orders = data.orders || [];
    if (!orders.length) return res.json({ success: true, renewed: 0 });
    const results = [];
    for (const order of orders) {
      const customerId = order.customer?.id;
      const customerEmail = order.email;
      if (!customerId) continue;
      const result = await shopifyRequest(SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN, 'POST', '/orders.json', {
        order: { customer: { id: customerId }, email: customerEmail, line_items: [{ variant_id: EVOLARI_SYNC_VARIANT_ID, quantity: 1 }], gateway: 'manual', financial_status: 'pending', tags: 'evolari-sync-renewal,auto-generated' }
      });
      if (result.order) {
        console.log(`[RENEWAL] ✓ #${result.order.order_number} for ${customerEmail}`);
        results.push({ customer: customerEmail, orderNumber: result.order.order_number });
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
    const data = await shopifyRequest(SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN, 'GET', '/orders.json?tag=evolari-subscription&status=any&limit=250');
    const orders = data.orders || [];
    if (!orders.length) { console.log('[CRON] No orders due'); return; }
    for (const order of orders) {
      const customerId = order.customer?.id;
      const customerEmail = order.email;
      if (!customerId) continue;
      const result = await shopifyRequest(SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN, 'POST', '/orders.json', {
        order: { customer: { id: customerId }, email: customerEmail, line_items: [{ variant_id: EVOLARI_SYNC_VARIANT_ID, quantity: 1 }], gateway: 'manual', financial_status: 'pending', tags: 'evolari-sync-renewal,auto-generated' }
      });
      if (result.order) console.log(`[CRON] ✓ #${result.order.order_number} for ${customerEmail}`);
    }
  } catch (err) { console.error('[CRON] Error:', err.message); }
});

console.log('[CRON] Scheduler active');
app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));
