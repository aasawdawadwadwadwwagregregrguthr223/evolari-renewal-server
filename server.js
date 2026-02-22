const express = require('express');
const cron = require('node-cron');
const app = express();
app.use(express.json());

const SHOPIFY_STORE = 'evolari.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const EVOLARI_SYNC_PRODUCT_ID = '10351296577841';
const PORT = process.env.PORT || 3000;

async function getVariantId() {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-01/products/${EVOLARI_SYNC_PRODUCT_ID}.json`, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
  });
  const data = await res.json();
  return data.product.variants[0].id;
}

async function createRenewalOrder(customerId, customerEmail, variantId) {
  const orderPayload = {
    order: {
      customer: { id: customerId },
      email: customerEmail,
      line_items: [{ variant_id: variantId, quantity: 1 }],
      gateway: 'manual',
      financial_status: 'pending',
      tags: 'evolari-sync-renewal,auto-generated',
      note: 'Auto-generated renewal order - Evolari Sync 30-day cycle'
    }
  };
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-01/orders.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(orderPayload)
  });
  return res.json();
}

async function getSubscriptionOrders() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const dateStr = thirtyDaysAgo.toISOString();
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2026-01/orders.json?tag=evolari-subscription&created_at_min=${dateStr}&status=any&limit=250`,
    { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
  );
  const data = await res.json();
  return data.orders || [];
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Evolari Renewal Server running', time: new Date().toISOString() });
});

// Test endpoint - open in browser to verify Shopify connection and see tagged orders
app.get('/test-renew', async (req, res) => {
  console.log('[TEST] Manual test triggered at', new Date().toISOString());
  try {
    const variantId = await getVariantId();
    const orders = await getSubscriptionOrders();
    res.json({
      success: true,
      shopify_connected: true,
      evolari_sync_variant_id: variantId,
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

// Manual trigger (POST)
app.post('/renew', async (req, res) => {
  console.log('[RENEWAL] Triggered at', new Date().toISOString());
  try {
    const variantId = await getVariantId();
    const orders = await getSubscriptionOrders();
    if (!orders.length) return res.json({ success: true, renewed: 0 });

    const results = [];
    for (const order of orders) {
      const customerId = order.customer?.id;
      const customerEmail = order.email;
      if (!customerId) continue;
      const result = await createRenewalOrder(customerId, customerEmail, variantId);
      if (result.order) {
        results.push({ customer: customerEmail, orderId: result.order.id, orderNumber: result.order.order_number });
        console.log(`[RENEWAL] ✓ #${result.order.order_number} for ${customerEmail}`);
      } else {
        console.log(`[RENEWAL] ✗ Failed for ${customerEmail}:`, JSON.stringify(result.errors));
      }
    }
    res.json({ success: true, renewed: results.length, orders: results });
  } catch (err) {
    console.error('[RENEWAL] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cron - every 30 days at 9am UTC
cron.schedule('0 9 */30 * *', async () => {
  console.log('[CRON] 30-day renewal triggered at', new Date().toISOString());
  try {
    const variantId = await getVariantId();
    const orders = await getSubscriptionOrders();
    if (!orders.length) { console.log('[CRON] No orders due'); return; }
    for (const order of orders) {
      const customerId = order.customer?.id;
      const customerEmail = order.email;
      if (!customerId) continue;
      const result = await createRenewalOrder(customerId, customerEmail, variantId);
      if (result.order) console.log(`[CRON] ✓ #${result.order.order_number} for ${customerEmail}`);
      else console.log(`[CRON] ✗ Failed for ${customerEmail}:`, JSON.stringify(result.errors));
    }
  } catch (err) { console.error('[CRON] Error:', err.message); }
});

console.log('[CRON] Renewal scheduler active - runs every 30 days at 9am UTC');
app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));
