/**
 * =========================================================
 * HYPERCAPE Shopify Webhook Server v4
 * Railway 배포 버전 (Node.js + Express)
 *
 * 기능:
 *   1. products/create 웹훅 수신
 *   2. OpenAI로 제품 설명 + 사용방법 자동 생성 (HTML, 영문)
 *   3. Canvas로 Facebook 광고용 템플릿 이미지 자동 생성
 *      - 첫 번째 제품 이미지(HyperCape 원본) 위에 오버레이
 *      - 원본 메인 이미지는 절대 변경하지 않음
 *      - 생성된 FB 이미지를 Shopify metafield에 저장
 *   4. Shopify body_html 자동 업데이트
 * =========================================================
 */

import express from 'express';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import { createCanvas, loadImage } from 'canvas';

const app = express();
app.use(express.json({ limit: '10mb' }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
});

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

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

async function generateDescription(product) {
  const category = detectCategory(product);
  const title = product.title || 'K-Beauty Product';
  const vendor = product.vendor || 'Korean Brand';
  const existing = (product.body_html || '').replace(/<[^>]*>/g, '').substring(0, 300);

  const systemMap = {
    kpop: 'You are a K-Pop merchandise expert copywriter. Write engaging, fan-focused content.',
    suncare: 'You are a K-Beauty sunscreen expert. Emphasize SPF protection and Korean formulation technology.',
    cleansing: 'You are a K-Beauty cleanser expert. Focus on skin type suitability, efficacy, and gentleness.',
    'toner-serum': 'You are a K-Beauty toner & serum expert. Focus on active ingredients and layering routine.',
    'masks-patches': 'You are a K-Beauty mask expert. Focus on ingredients, skin benefits, and ritual usage.',
    makeup: 'You are a K-Beauty makeup expert. Focus on coverage, finish, and longevity.',
    'hair-care': 'You are a K-Beauty hair care expert. Focus on hair type suitability and results.',
    'body-care': 'You are a K-Beauty body care expert. Focus on moisturization and skin type.',
    'beauty-device': 'You are a K-Beauty device expert. Focus on technology, clinical benefits, and ease of use.',
    skincare: 'You are a K-Beauty skincare expert. Focus on skin type, key ingredients, and benefits.'
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
  <li>🎵 1x CD</li>
  <li>📖 Photobook (XX pages)</li>
  <li>🃏 Random Photocard</li>
  <li>📜 Mini Poster</li>
  <li>🗂️ Folded Poster</li>
</ul>
<h3>⭐ About the Artist</h3>
<p>[2-3 sentences about the artist/group]</p>
<h3>🎁 Perfect Gift For</h3>
<p>[Who this is perfect for]</p>

Rules: fan-focused, exciting tone, HTML only, under 300 words, NO mention of any supplier.`

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
</ul>

<h3>💧 How to Use</h3>
<ol>
  <li>[Step 1 — cleanse first if needed]</li>
  <li>[Step 2]</li>
  <li>[Step 3]</li>
  <li>[Step 4 — follow with next step in routine]</li>
</ol>

<h3>👩 Best For</h3>
<p>[skin type / who benefits most]</p>

Rules:
- Professional but warm tone
- Lead with RESULTS not features
- Emoji at start of every bullet for visual appeal
- 300-400 words total
- HTML only
- NO mention of supplier, logistics company, or fulfillment`;

  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemMap[category] || systemMap.skincare },
        { role: 'user', content: userPrompt }
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

async function generateFacebookImage(product) {
  try {
    const imageUrl = product.images?.[0]?.src;
    if (!imageUrl) {
      console.log('[FB Image] No product image found, skipping');
      return null;
    }

    const W = 1200, H = 628;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    const img = await loadImage(imageUrl);
    const imgRatio = img.width / img.height;
    const canvasRatio = W / H;
    let sx, sy, sw, sh;
    if (imgRatio > canvasRatio) {
      sh = img.height; sw = img.height * canvasRatio;
      sx = (img.width - sw) / 2; sy = 0;
    } else {
      sw = img.width; sh = img.width / canvasRatio;
      sx = 0; sy = (img.height - sh) / 2;
    }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);

    const grad = ctx.createLinearGradient(0, 0, W * 0.65, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0.82)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0.55)');
    grad.addColorStop(1, 'rgba(0,0,0,0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    const category = detectCategory(product);
    const badgeText = category === 'kpop' ? 'K-POP' : 'K-BEAUTY';
    ctx.fillStyle = '#c0392b';
    ctx.beginPath();
    ctx.roundRect(36, 36, 130, 36, 8);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 15px Arial';
    ctx.textAlign = 'left';
    ctx.fillText(badgeText, 52, 59);

    const brand = product.vendor || '';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '500 20px Arial';
    ctx.fillText(brand.toUpperCase(), 36, 118);

    const rawTitle = (product.title || '').replace(/^\[.*?\]\s*/, '');
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px Arial';
    const maxW = W * 0.55;
    const words = rawTitle.split(' ');
    let line = '', lines = [];
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    lines = lines.slice(0, 3);
    lines.forEach((l, i) => ctx.fillText(l, 36, 168 + i * 46));

    const price = product.variants?.[0]?.price;
    const comparePrice = product.variants?.[0]?.compare_at_price;
    const yPrice = 168 + lines.length * 46 + 30;

    if (comparePrice && parseFloat(comparePrice) > parseFloat(price)) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '20px Arial';
      const cpText = `$${parseFloat(comparePrice).toFixed(2)}`;
      ctx.fillText(cpText, 36, yPrice);
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2;
      const cpW = ctx.measureText(cpText).width;
      ctx.moveTo(36, yPrice - 8); ctx.lineTo(36 + cpW, yPrice - 8);
      ctx.stroke();
      ctx.fillStyle = '#f59e0b';
      ctx.font = 'bold 42px Arial';
      ctx.fillText(`$${parseFloat(price).toFixed(2)}`, 36, yPrice + 50);
    } else if (price) {
      ctx.fillStyle = '#f59e0b';
      ctx.font = 'bold 42px Arial';
      ctx.fillText(`$${parseFloat(price).toFixed(2)}`, 36, yPrice + 20);
    }

    ctx.fillStyle = '#c0392b';
    ctx.fillRect(0, H - 60, W, 60);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Shop Now  —  Ships Direct from Korea', W / 2, H - 26);

    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '14px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('FREE shipping on orders over $80', 36, H - 72);

    const buffer = canvas.toBuffer('image/png');
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.error('[FB Image] Error:', err.message);
    return null;
  }
}

async function saveFacebookImageMetafield(productId, base64Image) {
  try {
    const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/products/${productId}/metafields.json`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ metafield: { namespace: 'marketing', key: 'fb_ad_image_base64', value: base64Image, type: 'string' } })
    });
    if (res.ok) { console.log(`[FB Image] Saved to metafield for product ${productId}`); return true; }
    console.error('[FB Image] Metafield save failed:', (await res.text()).substring(0, 200));
    return false;
  } catch (err) {
    console.error('[FB Image] Metafield error:', err.message);
    return false;
  }
}

async function updateShopifyProduct(productId, updateData) {
  const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/products/${productId}.json`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: updateData })
    });
    if (!res.ok) { console.error(`[Shopify] Update failed (${res.status}):`, (await res.text()).substring(0, 200)); return false; }
    return true;
  } catch (err) {
    console.error('[Shopify] Error:', err.message);
    return false;
  }
}

async function processProduct(product) {
  const title = product.title || '';
  const id = product.id;
  console.log(`\n[Process] Starting: ${id} — ${title}`);

  const existing = (product.body_html || '').replace(/<[^>]*>/g, '').trim();
  let newDescription = null;

  if (existing.length < 150) {
    console.log(`[OpenAI] Generating description...`);
    newDescription = await generateDescription(product);
    if (newDescription) console.log(`[OpenAI] Generated (${newDescription.length} chars)`);
  } else {
    console.log(`[OpenAI] Description exists (${existing.length} chars), skipping`);
  }

  console.log(`[FB Image] Generating Facebook ad template...`);
  const fbImage = await generateFacebookImage(product);
  if (fbImage) {
    console.log(`[FB Image] Generated (${Math.round(fbImage.length / 1024)}KB)`);
    await saveFacebookImageMetafield(id, fbImage);
  }

  if (newDescription) {
    const ok = await updateShopifyProduct(id, { body_html: newDescription });
    console.log(ok ? `[Shopify] Description updated: ${title}` : `[Shopify] Update failed: ${title}`);
  }

  console.log(`[Process] Done: ${title}\n`);
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Shopify Webhook Server v4 (HyperCape Edition)',
    logic: 'Auto-generates product description + Facebook ad image. Original product images untouched.',
    openai: process.env.OPENAI_API_KEY ? 'set' : 'missing',
    shopify: SHOPIFY_STORE || 'missing',
    time: new Date().toISOString()
  });
});

app.post('/webhook/product-create', async (req, res) => {
  res.sendStatus(200);
  const product = req.body;
  if (!product?.id) return;
  await processProduct(product);
});

app.post('/webhook/product-update', async (req, res) => {
  res.sendStatus(200);
  const product = req.body;
  if (!product?.id) return;
  const existing = (product.body_html || '').replace(/<[^>]*>/g, '').trim();
  if (existing.length > 150) return;
  await processProduct(product);
});

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
      await new Promise(r => setTimeout(r, 1500));
    }
  } else {
    res.status(400).json({ error: 'Provide product_id or all:true' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nHyperCape Webhook Server v4 on port ${PORT}`);
  console.log(`Store: ${SHOPIFY_STORE}`);
  console.log(`OpenAI: ${process.env.OPENAI_API_KEY ? 'configured' : 'MISSING'}`);
});

export default app;
