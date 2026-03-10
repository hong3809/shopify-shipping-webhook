const express = require('express');
const crypto = require('crypto');
const app = express();

const SHOPIFY_STORE_URL   = process.env.SHOPIFY_STORE_URL   || 'qnqvnj-wg.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const WEBHOOK_SECRET      = process.env.SHOPIFY_WEBHOOK_SECRET || '';
const PORT                = process.env.PORT || 3000;

const SHIPPING_VARIANTS = [
  { title: 'Standard Shipping', price: '5.00', requires_shipping: true },
  { title: 'Express Shipping',  price: '15.00', requires_shipping: true },
];

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Shopify Shipping Variant Webhook Server', time: new Date().toISOString() });
});

async function shopifyRequest(path, method = 'GET', body = null) {
  const url = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01${path}`;
  const options = {
    method,
    headers: {
      'Content-Type':           'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
    },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(`Shopify API ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function addShippingVariants(productId) {
  console.log(`\n[${new Date().toISOString()}] 처리 시작 → productId: ${productId}`);
  const { product } = await shopifyRequest(`/products/${productId}.json`);
  const existingTitles = product.variants.map(v => v.title);
  console.log('  기존 variants:', existingTitles);

  for (const sv of SHIPPING_VARIANTS) {
    if (existingTitles.includes(sv.title)) {
      console.log(`  ✅ 이미 존재: "${sv.title}" → 건너뜀`);
      continue;
    }
    const payload = {
      variant: {
        product_id:           productId,
        title:                sv.title,
        price:                sv.price,
        requires_shipping:    sv.requires_shipping,
        inventory_management: null,
        inventory_policy:     'continue',
        fulfillment_service:  'manual',
      },
    };
    const result = await shopifyRequest(`/products/${productId}/variants.json`, 'POST', payload);
    console.log(`  ✅ 추가 완료: "${sv.title}" (id: ${result.variant.id})`);
  }
  console.log(`  처리 완료 → productId: ${productId}\n`);
}

function verifyWebhook(req) {
  if (!WEBHOOK_SECRET) return true;
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac) return false;
  const digest = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.body).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

app.post('/webhook/product-create', async (req, res) => {
  if (!verifyWebhook(req)) return res.status(401).send('Unauthorized');
  res.sendStatus(200);
  try {
    const product = JSON.parse(req.body.toString());
    console.log(`🔔 Webhook 수신: products/create → id: ${product.id}, title: "${product.title}"`);
    await addShippingVariants(product.id);
  } catch (err) {
    console.error('❌ 처리 오류:', err.message);
  }
});

app.post('/test/add-shipping/:productId', async (req, res) => {
  try {
    await addShippingVariants(req.params.productId);
    res.json({ ok: true, productId: req.params.productId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 서버 실행 중: http://localhost:${PORT}`);
  console.log(`   Store   : ${SHOPIFY_STORE_URL}`);
  console.log(`   Token   : ${SHOPIFY_ADMIN_TOKEN ? '✅ 설정됨' : '❌ 미설정'}`);
});
