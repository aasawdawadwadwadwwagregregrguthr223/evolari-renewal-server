const express = require('express');
const app = express();
app.use(express.json());

const SHOPIFY_STORE = 'evolari.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const EVOLARI_SYNC_PRODUCT_ID = '10351296577841';
const PORT = process.env.PORT || 3000;

// Fetch product variant ID for Evolari Sync
async function getVariantId() {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-01/products/${EVOLARI_SYNC_PRODUCT_ID}.json`, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
  });
  const data = await res.json();
  return data.product.variants[0].id;
}

// Create a renewal order for a customer
async function createRenewalOrder(customerId, customerEmail, variantId) {
  const orderPayload = {
    order: {
      customer: { id: customerId },
      email: customerEmail,
      line_items: [
        {
          variant_id: variantId,
          quantity: 1
        }
      ],
      gateway: 'manual',
      financial_status: 'pending',
      tags: 'evolari-sync-renewal,auto-generated',
      note: 'Auto-generated renewal order - Evolari Sync 30-day cycle'
    }
  };

  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-01/orders.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(orderPayload)
  });

  const data = await res.json();
  return data;
}

// Fetch orders tagged as evolari-subscription from ~30 days ago
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

// Main renewal endpoint — called by Shopify Flow every 30 days
app.post('/renew', async (req, res) => {
  console.log('[RENEWAL] Triggered at', new Date().toISOString());

  try {
    const variantId = await getVariantId();
    const orders = await getSubscriptionOrders();

    if (!orders.length) {
      console.log('[RENEWAL] No subscription orders found due for renewal');
      return res.json({ success: true, renewed: 0 });
    }

    const results = [];

    for (const order of orders) {
      const customerId = order.customer?.id;
      const customerEmail = order.email;

      if (!customerId) {
        console.log(`[RENEWAL] Skipping order ${order.id} - no customer ID`);
        continue;
      }

      console.log(`[RENEWAL] Creating renewal for customer ${customerId} (${customerEmail})`);
      const result = await createRenewalOrder(customerId, customerEmail, variantId);

      if (result.order) {
        console.log(`[RENEWAL] ✓ Created order #${result.order.order_number} for ${customerEmail}`);
        results.push({ customer: customerEmail, orderId: result.order.id, orderNumber: result.order.order_number });
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

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Evolari Renewal Server running', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[SERVER] Evolari Renewal Server listening on port ${PORT}`);
});