/**
 * =========================================================
 * HYPERCAPE Shopify Webhook Server v4
 * Railway 배포 버전 (Node.js + Express)
 *
 * 기능:
 *   1. products/create 웹훅 수신
 *   2. OpenAI로 제품 설명 + 사용방법 자동 생성 (HTML, 영문)
 *   3. OpenAI DALL-E로 Facebook 광고용 이미지 자동 생성
 *      - 원본 메인 이미지는 절대 변경하지 않음
 *      - 생성된 FB 이미지 URL을 Shopify metafield에 저장
 *   4. Shopify body_html 자동 업데이트
 * =========================================================
 */

import express from 'express';
import OpenAI from 'openai';
import fetch from 'node-fetch';

const app = express();
app.use(express.json({ limit: '10mb' }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
});

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ─── 제품 카테고리 감지 ─────────────────────────────────
function detectCategory(product) {
  const text = ((product.title || '') + ' ' + (product.tags || '')).toLowerCase();
  if (text.match(/album|mini album|kpop|k-pop|blackpink|bts|aespa|twice|ive|newjeans|stray kids|le sserafim|lightstick|photocard/)) return 'kpop';
  if (text.match(/sunscreen|spf|uv|sun cream|suncare/)) return 'suncare';
  if (text.match(/cleanser|cleansing|foam|face wash|micellar/)) return 'cleansing';
  if (text.match(/toner|serum|essence|ampoule|booster/)) return 'toner-serum';
  if (text.match(/sheet mask|face mask|sleeping mask|pimple patch|glow mask|honey mask|rice mask/)) return 'masks-patches';
  if (text.match(/makeup|foundation|cushion|bb cream|lip |lipstick|blush|eyeshadow/)) return 'makeup';
  if (text.match(/shampoo|conditioner|hair mask|hair treatment|hair serum|scalp/)) return 'hair-care';
  if (text.match(/body lotion|body wash|body cream|hand cream|body scrub/)) return 'body-care';
  if (text.match(/led mask|face roller|gua sha|dermaroller|beauty device|facial massager/)) return 'beauty-device';
  return 'skincare';
}

// ─── OpenAI 제품 설명 생성 ──────────────────────────────
async function generateDescription(product) {
  const category = detectCategory(product);
  const title = product.title || 'K-Beauty Product';
  const vendor = product.vendor || 'Korean Brand';
  const existing = (product.body_html || '').replace(/<[^>]*>/g, '').substring(0, 300);

  const systemMap = {
    kpop:           'You are a K-Pop merchandise expert copywriter. Write engaging, fan-focused content.',
    suncare:        'You are a K-Beauty sunscreen expert. Emphasize SPF protection and Korean formulation technology.',
    cleansing:      'You are a K-Beauty cleanser expert. Focus on skin type suitability, efficacy, and gentleness.',
    'toner-serum':  'You are a K-Beauty toner & serum expert. Focus on active ingredients and layering routine.',
    'masks-patches':'You are a K-Beauty mask expert. Focus on ingredients, skin benefits, and ritual usage.',
    makeup:         'You are a K-Beauty makeup expert. Focus on coverage, finish, and longevity.',
    'hair-care':    'You are a K-Beauty hair care expert. Focus on hair type suitability and results.',
    'body-care':    'You are a K-Beauty body care expert. Focus on moisturization and skin type.',
    'beauty-device':'You are a K-Beauty device expert. Focus on technology, clinical benefits, and ease of use.',
    skincare:       'You are a K-Beauty skincare expert. Focus on skin type, key ingredients, and benefits.'
  };

  const isKpop = category === 'kpop';

  const userPrompt = isKpop
    ? `Write an engaging HTML product description for this K-Pop item:

Product: ${title}
Brand: ${vendor}
Existing info: ${existing || 'none'}

Structure (HTML only, no markdown):
<p><strong>[2-3 sentence exciting intro about this release]</strong></p>
<h3>📀 What's Inside the Box</h3>
<ul>
  <li>🎵 1x CD with all tracks</li>
  <li>📖 Photobook</li>
  <li>🃏 1x Random Photocard</li>
  <li>📜 1x Mini Poster</li>
  <li>🗂️ 1x Folded Poster</li>
</ul>
<h3>⭐ About the Artist</h3>
<p>[2-3 sentences about the artist/group]</p>
<h3>🎁 Perfect Gift For</h3>
<p>[Who this is perfect for]</p>

Rules: fan-focused, exciting tone, HTML only, under 300 words, NO mention of any supplier or logistics.`

    : `Write a compelling HTML product description for this K-Beauty product:

Product: ${title}
Brand: ${vendor}
Category: ${category}
Existing info: ${existing || 'none'}

Structure (HTML only, no markdown):
<p><strong>[2-3 sentence hero description — lead with the #1 skin benefit/result]</strong></p>

<h3>✨ Key Benefits</h3>
<ul>
  <li>🌟 [benefit 1]</li>
  <li>💧 [benefit 2]</li>
  <li>🌿 [benefit 3]</li>
  <li>✅ [benefit 4]</li>
</ul>

<h3>🌿 Key Ingredients</h3>
<ul>
  <li><strong>[Ingredient 1]</strong> — [what it does in 1 line]</li>
  <li><strong>[Ingredient 2]</strong> — [what it does in 1 line]</li>
  <li><strong>[Ingredient 3]</strong> — [what it does in 1 line]</li>
</ul>

<h3>💧 How to Use</h3>
<ol>
  <li>[Step 1 — start with clean skin]</li>
  <li>[Step 2]</li>
  <li>[Step 3]</li>
  <li>[Step 4 — follow with next step in routine]</li>
</ol>

<h3>👩 Best For</h3>
<p>[skin type / who benefits most — 1-2 sentences]</p>

Rules:
- Professional but warm tone
- Lead with RESULTS not features
- Emoji at start of every bullet for visual appeal
- 300-400 words total
- HTML only
- NO mention of supplier, logistics, or fulfillment`;

  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemMap[category] || systemMap.skincare },
        { role: 'user',   content: userPrompt }
      ],
      max_tokens: 900,
      temperature: 0.7
    });
    return res.choices[0].message.content.trim();
  } catch (err) {
    console.error('[OpenAI] Description error:', err.message);
    return null;
  }
}

// ─── Facebook 광고 이미지 프롬프트 생성 ─────────────────
// DALL-E 대신 OpenAI Image API로 생성 (canvas 불필요)
async function generateFacebookImageUrl(product) {
  try {
    const category = detectCategory(product);
    const title = (product.title || '').replace(/^\[.*?\]\s*/, '');
    const vendor = product.vendor || '';
    const price = product.variants?.[0]?.price;
    const priceText = price ? `$${parseFloat(price).toFixed(2)}` : '';

    const isKpop = category === 'kpop';

    const prompt = isKpop
      ? `Facebook ad image for K-Pop album "${title}" by ${vendor}. 
         Professional e-commerce advertisement style. 
         Dark background with neon pink/purple accents. 
         Bold text overlay: "${vendor}" at top, "${title}" in center, "${priceText}" in gold.
         Bottom red banner: "Shop Now — Ships Direct from Korea".
         High quality, 1200x628 landscape format, clean modern design.
         NO real photos of people, artistic promotional style.`

      : `Facebook ad image for Korean beauty product "${title}" by ${vendor}.
         Professional K-Beauty e-commerce advertisement.
         Clean white/soft pink background with elegant styling.
         Product showcase style with text overlays.
         Brand: "${vendor}" in elegant font at top.
         Product: "${title}" as main headline.
         Price: "${priceText}" in amber/gold color.
         Bottom red banner: "Shop Now — Ships Direct from Korea".
         Style: clean, modern, trustworthy Korean beauty brand aesthetic.
         1200x628 landscape format, high quality product advertisement.`;

    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt: prompt,
      n: 1,
      size: '1792x1024',
      quality: 'standard'
    });

    const imageUrl = response.data[0]?.url;
    if (imageUrl) {
      console.log(`[FB Image] ✅ Generated DALL-E image URL`);
      return imageUrl;
    }
    return null;
  } catch (err) {
    console.error('[FB Image] DALL-E error:', err.message);
    return null;
  }
}

// ─── Shopify: FB 이미지 URL을 metafield에 저장 ──────────
async function saveFacebookImageUrl(productId, imageUrl) {
  try {
    const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/products/${productId}/metafields.json`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        metafield: {
          namespace: 'marketing',
          key: 'fb_ad_image_url',
          value: imageUrl,
          type: 'url'
        }
      })
    });
    if (res.ok) {
      console.log(`[FB Image] ✅ URL saved to metafield: product ${productId}`);
      return true;
    }
    console.error('[FB Image] Metafield save failed:', (await res.text()).substring(0, 200));
    return false;
  } catch (err) {
    console.error('[FB Image] Metafield error:', err.message);
    return false;
  }
}

// ─── Shopify: 제품 업데이트 ─────────────────────────────
async function updateShopifyProduct(productId, updateData) {
  const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/products/${productId}.json`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ product: updateData })
    });
    if (!res.ok) {
      console.error(`[Shopify] Update failed (${res.status}):`, (await res.text()).substring(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Shopify] Error:', err.message);
    return false;
  }
}

// ─── 메인 처리 로직 ─────────────────────────────────────
async function processProduct(product) {
  const title = product.title || '';
  const id = product.id;
  console.log(`\n[Process] 🚀 Starting: ${id} — ${title}`);

  // 1. 제품 설명 생성 (설명이 없거나 짧은 경우만)
  const existing = (product.body_html || '').replace(/<[^>]*>/g, '').trim();
  let newDescription = null;

  if (existing.length < 150) {
    console.log(`[OpenAI] Generating description...`);
    newDescription = await generateDescription(product);
    if (newDescription) {
      console.log(`[OpenAI] ✅ Generated (${newDescription.length} chars)`);
    }
  } else {
    console.log(`[OpenAI] Description exists (${existing.length} chars), skipping`);
  }

  // 2. Facebook 광고 이미지 생성
  console.log(`[FB Image] Generating Facebook ad image...`);
  const fbImageUrl = await generateFacebookImageUrl(product);
  if (fbImageUrl) {
    await saveFacebookImageUrl(id, fbImageUrl);
  }

  // 3. Shopify 제품 설명 업데이트 (이미지는 건드리지 않음)
  if (newDescription) {
    const ok = await updateShopifyProduct(id, { body_html: newDescription });
    console.log(ok
      ? `[Shopify] ✅ Description updated: ${title}`
      : `[Shopify] ❌ Update failed: ${title}`
    );
  }

  console.log(`[Process] ✅ Done: ${title}\n`);
}

// ─── 라우트 ─────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Shopify Webhook Server v4 (HyperCape Edition)',
    logic: 'Auto-generates product description + Facebook ad image (DALL-E). Original product images untouched.',
    openai: process.env.OPENAI_API_KEY ? 'set' : 'missing',
    shopify: SHOPIFY_STORE || 'missing',
    time: new Date().toISOString()
  });
});

// 제품 생성 웹훅
app.post('/webhook/product-create', async (req, res) => {
  res.sendStatus(200); // Shopify 타임아웃 방지 — 즉시 응답
  const product = req.body;
  if (!product?.id) return;
  await processProduct(product);
});

// 제품 업데이트 웹훅
app.post('/webhook/product-update', async (req, res) => {
  res.sendStatus(200);
  const product = req.body;
  if (!product?.id) return;
  const existing = (product.body_html || '').replace(/<[^>]*>/g, '').trim();
  if (existing.length > 150) return;
  await processProduct(product);
});

// 백필: 기존 제품 설명 채우기
// POST /backfill  { "product_id": "1234567" }  or  { "all": true }
app.post('/backfill', async (req, res) => {
  const { product_id, all } = req.body || {};

  if (product_id) {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/products/${product_id}.json`, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
    });
    const { product } = await r.json();
    res.json({ status: 'processing', product: product.title });
    await processProduct(product);

  } else if (all) {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=50&status=active`, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
    });
    const { products } = await r.json();
    res.json({ status: 'processing', count: products.length });
    for (const p of products) {
      await processProduct(p);
      await new Promise(r => setTimeout(r, 2000));
    }
  } else {
    res.status(400).json({ error: 'Provide product_id or all:true' });
  }
});

// ─── 서버 시작 ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 HyperCape Webhook Server v4 on port ${PORT}`);
  console.log(`   Store  : ${SHOPIFY_STORE}`);
  console.log(`   OpenAI : ${process.env.OPENAI_API_KEY ? '✅ configured' : '❌ MISSING'}`);
  console.log(`   Model  : ${MODEL}`);
  console.log(`   FB Image: DALL-E 3 (no canvas dependency)\n`);
});

export default app;
