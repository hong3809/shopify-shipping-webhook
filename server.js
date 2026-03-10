const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const app     = express();

const SHOPIFY_STORE_URL   = process.env.SHOPIFY_STORE_URL   || 'qnqvnj-wg.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const WEBHOOK_SECRET      = process.env.SHOPIFY_WEBHOOK_SECRET || '';
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const PORT                = process.env.PORT || 3000;

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Shopify Webhook Server', openai: OPENAI_API_KEY ? '설정됨' : '미설정', time: new Date().toISOString() });
});

async function shopifyRequest(path, method = 'GET', body = null) {
  const url = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01${path}`;
  const options = { method, headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN } };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(`Shopify API ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function callOpenAI(prompt) {
  const body = JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 2000, temperature: 0.7 });
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { const json = JSON.parse(data); if (json.error) return reject(new Error(json.error.message)); resolve(json.choices[0].message.content.trim()); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function generateProductDescription(product) {
  console.log(`  [AI] 제품 설명 생성 중: "${product.title}"`);
  const prompt = `You are a K-Beauty product expert. Generate a detailed, engaging product description in English for this Korean beauty product for a Shopify store.

Product Name: ${product.title}
Brand: ${product.vendor || ''}
Type: ${product.product_type || ''}
Tags: ${product.tags || ''}

Create a comprehensive HTML product description including:
1. Product Overview (2-3 sentences about main benefits)
2. Key Ingredients & Benefits (3-5 key ingredients)
3. How to Use (step-by-step, 4-6 steps)
4. Suitable Skin Types
5. Why Choose This Product (3 reasons)

Use only these HTML tags: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>
Do NOT include <html>, <head>, <body> tags or CSS styles.`;
  return await callOpenAI(prompt);
}

async function updateProductDescription(productId, bodyHtml) {
  await shopifyRequest(`/products/${productId}.json`, 'PUT', { product: { id: productId, body_html: bodyHtml } });
  console.log(`  [AI] 설명 업데이트 완료 → productId: ${productId}`);
}

async function addShippingVariants(productId) {
  const { product } = await shopifyRequest(`/products/${productId}.json`);
  const existingTitles = product.variants.map(v => v.title);
  const SHIPPING_VARIANTS = [
    { title: 'Standard Shipping (7-14 Days)', requires_shipping: true },
    { title: 'Economy Shipping (5-7 Days)',   requires_shipping: true },
    { title: 'Express Shipping (3-5 Days)',   requires_shipping: true },
  ];
  for (const sv of SHIPPING_VARIANTS) {
    if (existingTitles.some(t => t.includes(sv.title.split('(')[0].trim()))) { console.log(`  已存在: "${sv.title}"`); continue; }
    const payload = { variant: { product_id: productId, title: sv.title, price: product.variants[0]?.price || '0.00', requires_shipping: sv.requires_shipping, inventory_management: null, inventory_policy: 'continue', fulfillment_service: 'manual' } };
    const result = await shopifyRequest(`/products/${productId}/variants.json`, 'POST', payload);
    console.log(`  variant 추가: "${sv.title}" (id: ${result.variant.id})`);
  }
}

async function processNewProduct(product) {
  console.log(`\n새 제품 처리: "${product.title}"`);
  if (OPENAI_API_KEY) {
    try {
      const textOnly = (product.body_html || '').replace(/<[^>]+>/g, '').trim();
      if (textOnly.length < 200) { const newHtml = await generateProductDescription(product); await updateProductDescription(product.id, newHtml); }
      else { console.log(`  설명 충분 (${textOnly.length}자) → 건너뜀`); }
    } catch (err) { console.error(`  [AI] 오류:`, err.message); }
  }
  try { await addShippingVariants(product.id); } catch (err) { console.error(`  [Shipping] 오류:`, err.message); }
  console.log(`처리 완료: "${product.title}"`);
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
  try { const product = JSON.parse(req.body.toString()); await processNewProduct(product); }
  catch (err) { console.error('Webhook 오류:', err.message); }
});

app.post('/test/generate-description/:productId', async (req, res) => {
  try {
    const { product } = await shopifyRequest(`/products/${req.params.productId}.json`);
    const newHtml = await generateProductDescription(product);
    await updateProductDescription(product.id, newHtml);
    res.json({ ok: true, productId: product.id, title: product.title });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/test/add-shipping/:productId', async (req, res) => {
  try { await addShippingVariants(req.params.productId); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/bulk/generate-descriptions', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ started: true, message: '백그라운드 실행 중...' });
  try {
    const { products } = await shopifyRequest('/products.json?limit=250&fields=id,title,vendor,product_type,tags,body_html');
    console.log(`[BULK] ${products.length}개 제품 처리 시작`);
    for (const product of products) {
      try {
        const textOnly = (product.body_html || '').replace(/<[^>]+>/g, '').trim();
        if (textOnly.length < 200) { const newHtml = await generateProductDescription(product); await updateProductDescription(product.id, newHtml); console.log(`[BULK] 완료: ${
