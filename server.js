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
  res.json({ status: 'ok', message: 'Shopify Webhook Server v2', openai: OPENAI_API_KEY ? 'set' : 'not set', time: new Date().toISOString() });
});

async function shopifyRequest(path, method, body) {
  method = method || 'GET';
  const url = 'https://' + SHOPIFY_STORE_URL + '/admin/api/2024-01' + path;
  const options = { method: method, headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN } };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error('Shopify API ' + res.status + ': ' + JSON.stringify(data));
  return data;
}

async function callOpenAI(prompt) {
  const bodyStr = JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 2000, temperature: 0.7 });
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Length': Buffer.byteLength(bodyStr) }
    }, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          resolve(json.choices[0].message.content.trim());
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function generateHowToSection(product) {
  console.log('[AI] 사용방법 섹션 생성 중: ' + product.title);
  const prompt = 'You are a K-Beauty product expert. Create a beautifully formatted "How to Use" section in English for the following Korean beauty product.\n\nProduct Name: ' + product.title + '\nBrand: ' + (product.vendor || '') + '\nType: ' + (product.product_type || '') + '\n\nGenerate ONLY the following sections in clean HTML (no <html><head><body> tags, no CSS styles):\n\n1. A divider line using <hr>\n2. "How to Use" section with step-by-step instructions (4-6 steps) using <ol><li>\n3. "Key Ingredients" section listing 3-5 main ingredients and their benefits using <ul><li>\n4. "Skin Type" section - who this is best for using <p>\n5. "Pro Tips" section - 2-3 expert tips for best results using <ul><li>\n\nUse these HTML tags only: <hr>, <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>\nMake it professional, engaging, and helpful for customers.\nKeep each section concise and easy to read.';
  return await callOpenAI(prompt);
}

async function appendHowToSection(productId, existingHtml, newSectionHtml) {
  const updatedHtml = existingHtml + '\n\n' + newSectionHtml;
  await shopifyRequest('/products/' + productId + '.json', 'PUT', {
    product: { id: productId, body_html: updatedHtml }
  });
  console.log('[AI] 사용방법 섹션 추가 완료: ' + productId);
}

async function addShippingVariants(productId) {
  console.log('[Shipping] variant 처리: ' + productId);
  const data = await shopifyRequest('/products/' + productId + '.json');
  const product = data.product;
  const existingTitles = product.variants.map(function(v) { return v.title; });
  const basePrice = product.variants[0] ? product.variants[0].price : '0.00';
  const shippingList = [
    'Standard Shipping (7-14 Days)',
    'Economy Shipping (5-7 Days)',
    'Express Shipping (3-5 Days)'
  ];
  for (let i = 0; i < shippingList.length; i++) {
    const title = shippingList[i];
    const keyword = title.split('(')[0].trim();
    let exists = false;
    for (let j = 0; j < existingTitles.length; j++) {
      if (existingTitles[j].indexOf(keyword) !== -1) { exists = true; break; }
    }
    if (exists) { console.log('[Shipping] 이미 존재: ' + title); continue; }
    const payload = {
      variant: {
        product_id: productId, title: title, price: basePrice,
        requires_shipping: true, inventory_management: null,
        inventory_policy: 'continue', fulfillment_service: 'manual'
      }
    };
    const result = await shopifyRequest('/products/' + productId + '/variants.json', 'POST', payload);
    console.log('[Shipping] 추가완료: ' + title + ' id:' + result.variant.id);
  }
}

async function processNewProduct(product) {
  console.log('\n=== 새 제품 처리: ' + product.title + ' ===');
  if (OPENAI_API_KEY) {
    try {
      const existingHtml = product.body_html || '';
      if (existingHtml.toLowerCase().indexOf('how to use') !== -1) {
        console.log('[AI] 이미 사용방법 있음 → 건너뜀');
      } else {
        const newSection = await generateHowToSection(product);
        await appendHowToSection(product.id, existingHtml, newSection);
      }
    } catch(err) { console.error('[AI] 오류:', err.message); }
  }
  try {
    await addShippingVariants(product.id);
  } catch(err) { console.error('[Shipping] 오류:', err.message); }
  console.log('=== 처리완료: ' + product.title + ' ===\n');
}

function verifyWebhook(req) {
  if (!WEBHOOK_SECRET) return true;
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac) return false;
  const digest = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.body).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

app.post('/webhook/product-create', async function(req, res) {
  if (!verifyWebhook(req)) return res.status(401).send('Unauthorized');
  res.sendStatus(200);
  try {
    const product = JSON.parse(req.body.toString());
    await processNewProduct(product);
  } catch(err) { console.error('Webhook 오류:', err.message); }
});

app.post('/test/append-howto/:productId', async function(req, res) {
  try {
    const data = await shopifyRequest('/products/' + req.params.productId + '.json');
    const product = data.product;
    const existingHtml = product.body_html || '';
    if (existingHtml.toLowerCase().indexOf('how to use') !== -1) {
      return res.json({ ok: true, skipped: true, message: '이미 How to Use 섹션 있음' });
    }
    const newSection = await generateHowToSection(product);
    await appendHowToSection(product.id, existingHtml, newSection);
    res.json({ ok: true, productId: product.id, title: product.title });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/test/add-shipping/:productId', async function(req, res) {
  try {
    await addShippingVariants(req.params.productId);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/bulk/append-howto', async function(req, res) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ started: true, message: '백그라운드 실행 중 - Railway 로그에서 진행상황 확인 가능' });
  try {
    const data = await shopifyRequest('/products.json?limit=250&fields=id,title,vendor,product_type,tags,body_html');
    const products = data.products;
    console.log('[BULK] ' + products.length + '개 제품 처리 시작');
    for (let i = 0; i < products.length; i++) {
      try {
        const existingHtml = products[i].body_html || '';
        if (existingHtml.toLowerCase().indexOf('how to use') !== -1) {
          console.log('[BULK] 건너뜀(이미 있음): ' + products[i].title);
          continue;
        }
        const newSection = await generateHowToSection(products[i]);
        await appendHowToSection(products[i].id, existingHtml, newSection);
        console.log('[BULK] 완료 (' + (i+1) + '/' + products.length + '): ' + products[i].title);
        await new Promise(function(r) { setTimeout(r, 1500); });
      } catch(e) { console.error('[BULK] 오류: ' + products[i].title + ' - ' + e.message); }
    }
    console.log('[BULK] 전체완료!');
  } catch(err) { console.error('[BULK] 오류:', err.message); }
});

app.listen(PORT, function() {
  console.log('서버 실행: http://localhost:' + PORT);
  console.log('Store: ' + SHOPIFY_STORE_URL);
  console.log('Token: ' + (SHOPIFY_ADMIN_TOKEN ? '설정됨' : '미설정'));
  console.log('OpenAI: ' + (OPENAI_API_KEY ? '설정됨' : '미설정'));
});
