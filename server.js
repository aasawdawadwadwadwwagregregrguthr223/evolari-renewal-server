const express = require('express');
const cron = require('node-cron');
const app = express();
app.use(express.json());

const SHOPIFY_STORE = 'evolari.myshopify.com';
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const EVOLARI_SYNC_VARIANT_ID = 52855103750449;
const PORT = process.env.PORT || 3000;

function getAuthHeader() {
  const credentials = Buffer.from(`${SHOPIFY_API_KEY}:${SHOPIFY_API_SECRET}`).toString('base64');
  return `Basic ${credentials}`;
}

async function createRenewalOrder(customerId, customerEmail) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-10/orders.json`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      order: {
        customer: { id: customerId },
        email: customerEmail,
        line_items: [{ variant_id: EVOLARI_SYNC_VARIANT_ID, quantity: 1 }],
        gateway: 'manual',
        financial_status: 'pending',
        tags: 'evolari-sync-renewal,auto-generated',
        note: 'Auto-generated renewal order - Evolari Sync 30-day cycle'
      }
    })
  });
  return res.json();
}

async function getSubscriptionOrders() {
  const url = `https://${SHOPIFY_STORE}/admin/api/2024-10/orders.json?tag=evolari-subscription&status=any&limit=250`;
  const res = await fetch(url, {
    headers: { 'Authorization': getAuthHeader() }
  });
  const data = await res.json();
  console.log('[DEBUG] Orders response:', JSON.stringify(data));
  return data.orders || [];
}

app.get('/', (req, res) => {
  res.json({ status: 'Evolari Renewal Server running', time: new Date().toISOString() });
});

app.get('/test-renew', async (req, res) => {
  console.log('[TEST] Triggered. Keys present:', !!SHOPIFY_API_KEY, !!SHOPIFY_API_SECRET);
  try {
    const orders = await getSubscriptionOrders();
    res.json({
      success: true,
      keys_loaded: !!SHOPIFY_API_KEY && !!SHOPIFY_API_SECRET,
      variant_id: EVOLARI_SYNC_VARIANT_ID,
      subscription_orders_found: orders.length,
      orders: orders.map(o => ({
        order_id: o.id,
        order_number: o.order_number,
        customer_email: o.email,
        customer_id: o.customer?.id,
        tags: o.tags,
        created_at: o.created_at
      }))
    });
  } catch (err) {
    console.error('[TEST] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/renew', async (req, res) => {
  try {
    const orders = await getSubscriptionOrders();
    if (!orders.length) return res.json({ success: true, renewed: 0 });
    const results = [];
    for (const order of orders) {
      const customerId = order.customer?.id;
      const customerEmail = order.email;
      if (!customerId) continue;
      const result = await createRenewalOrder(customerId, customerEmail);
      if (result.order) {
        console.log(`[RENEWAL] ✓ #${result.order.order_number} for ${customerEmail}`);
        results.push({ customer: customerEmail, orderId: result.order.id, orderNumber: result.order.order_number });
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
  console.log('[CRON] Triggered at', new Date().toISOString());
  try {
    const orders = await getSubscriptionOrders();
    if (!orders.length) { console.log('[CRON] No orders due'); return; }
    for (const order of orders) {
      const customerId = order.customer?.id;
      const customerEmail = order.email;
      if (!customerId) continue;
      const result = await createRenewalOrder(customerId, customerEmail);
      if (result.order) console.log(`[CRON] ✓ #${result.order.order_number} for ${customerEmail}`);
      else console.log(`[CRON] ✗ Failed:`, JSON.stringify(result.errors));
    }
  } catch (err) { console.error('[CRON] Error:', err.message); }
});

console.log('[CRON] Scheduler active');
app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));
