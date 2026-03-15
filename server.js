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
    let content = res.choices[0].message.content.trim();

    // ─── 마크다운 코드블록 자동 제거 ───────────────────────
    // OpenAI가 ```html ... ``` 형식으로 감싸서 반환하는 경우 제거
    content = content.replace(/^```html\s*\n?/i, '');
    content = content.replace(/\n?```\s*$/i, '');
    content = content.replace(/```html\s*\n?/gi, '');
    content = content.replace(/\n?```/g, '');
    content = content.trim();

    return content;
  } catch (err) {
    console.error('[OpenAI] Description error:', err.message);
    return null;
  }
}

// ─── Facebook 광고 이미지 프롬프트 생성 ─────────────────
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

// ─── DALL-E 이미지를 Shopify CDN에 영구 업로드 ──────────
async function uploadImageToShopifyCDN(imageUrl, filename) {
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
    const buffer = await imgRes.buffer();
    const base64 = buffer.toString('base64');

    const uploadUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/themes/147194871969/assets.json`;
    const graphqlUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`;
    const mutation = `
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            ... on MediaImage {
              image { url }
            }
          }
          userErrors { field message }
        }
      }
    `;
    const gqlRes = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          files: [{
            alt: 'FB Ad Image',
            contentType: 'IMAGE',
            originalSource: imageUrl
          }]
        }
      })
    });
    const gqlData = await gqlRes.json();
    const cdnUrl = gqlData?.data?.fileCreate?.files?.[0]?.image?.url;
    if (cdnUrl) {
      console.log(`[FB Image] ✅ Uploaded to Shopify CDN: ${cdnUrl.substring(0, 60)}...`);
      return cdnUrl;
    }
    console.warn('[FB Image] CDN upload failed, using original URL');
    return imageUrl;
  } catch (err) {
    console.error('[FB Image] CDN upload error:', err.message);
    return imageUrl;
  }
}

// ─── Shopify: FB 이미지 URL을 metafield에 저장 ──────────
async function saveFacebookImageUrl(productId, imageUrl) {
  try {
    console.log(`[FB Image] Uploading to Shopify CDN...`);
    const permanentUrl = await uploadImageToShopifyCDN(imageUrl, `fb_ad_${productId}.png`);

    const listUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/products/${productId}/metafields.json`;
    const listRes = await fetch(listUrl, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
    });
    const listData = await listRes.json();
    const existing = listData.metafields?.find(m => m.key === 'fb_ad_image_url');

    let url, method, body;
    if (existing) {
      url = `https://${SHOPIFY_STORE}/admin/api/2024-01/metafields/${existing.id}.json`;
      method = 'PUT';
      body = JSON.stringify({ metafield: { id: existing.id, value: permanentUrl } });
    } else {
      url = listUrl;
      method = 'POST';
      body = JSON.stringify({
        metafield: {
          namespace: 'marketing',
          key: 'fb_ad_image_url',
          value: permanentUrl,
          type: 'url'
        }
      });
    }

    const res = await fetch(url, {
      method,
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      },
      body
    });
    if (res.ok) {
      console.log(`[FB Image] ✅ Permanent URL saved to metafield: product ${productId}`);
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

  console.log(`[FB Image] Generating Facebook ad image...`);
  const fbImageUrl = await generateFacebookImageUrl(product);
  if (fbImageUrl) {
    await saveFacebookImageUrl(id, fbImageUrl);
  }

  if (newDescription) {
    const ok = await updateShopifyProduct(id, { body_html: newDescription });
    console.log(ok
      ? `[Shopify] ✅ Description updated: ${title}`
      : `[Shopify] ❌ Update failed: ${title}`
    );
  }

  console.log(`[Process] ✅ Done: ${title}\n`);
}

// ─── Facebook/Instagram 카탈로그 피드 생성 ──────────────
async function buildFacebookCatalogFeed() {
  const r = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=250&status=active`,
    { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
  );
  const { products } = await r.json();

  const metaMap = {};
  for (const p of products) {
    if (p.tags?.includes('shipping-fee-hidden')) continue;
    try {
      const mr = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2024-01/products/${p.id}/metafields.json`,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
      );
      const md = await mr.json();
      const fbMeta = md.metafields?.find(m => m.key === 'fb_ad_image_url');
      if (fbMeta?.value) metaMap[p.id] = fbMeta.value;
    } catch {}
  }

  const storeUrl = process.env.STORE_DOMAIN ? `https://${process.env.STORE_DOMAIN}` : `https://sojudad.com`;

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Sojudad K-Beauty Store</title>
    <link>${storeUrl}</link>
    <description>K-Beauty and K-Pop products catalog</description>
`;

  for (const p of products) {
    // Shipping Fee 제품 제외 (태그 또는 handle 또는 title 기반)
    if (
      p.tags?.includes('shipping-fee-hidden') ||
      p.handle === 'shipping-fee' ||
      /^shipping\s*fee$/i.test((p.title || '').trim())
    ) continue;

    // HTML 태그 제거 + 마크다운 코드블록 제거 후 텍스트 정리
    let rawDesc = (p.body_html || '');
    rawDesc = rawDesc.replace(/```html\s*\n?/gi, '').replace(/\n?```/g, '');
    const desc = rawDesc.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().substring(0, 5000);
    const fbImageUrl = metaMap[p.id];

    for (const v of p.variants) {
      const productUrl = `https://sojudad.com/products/${p.handle}`;
      const mainImage = p.images?.[0]?.src || '';
      const adImage = fbImageUrl || mainImage;

      const inStock = v.inventory_policy === 'continue' || (v.inventory_quantity ?? 0) > 0;
      const availability = inStock ? 'in stock' : 'out of stock';

      const brand = p.vendor || 'Korean Brand';
      const category = detectCategory(p);
      const googleCategory = category === 'kpop'
        ? 'Media > Music > Music CDs & LPs'
        : 'Health & Beauty > Personal Care > Cosmetics';

      const variantTitle = v.title !== 'Default Title' ? ` - ${v.title}` : '';
      const itemTitle = `${p.title}${variantTitle}`.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const itemId = `shopify_US_${p.id}_${v.id}`;
      const sku = v.sku || itemId;

      xml += `
    <item>
      <g:id>${itemId}</g:id>
      <g:item_group_id>shopify_US_${p.id}</g:item_group_id>
      <title>${itemTitle}</title>
      <description><![CDATA[${desc || itemTitle}]]></description>
      <link>${productUrl}</link>
      <g:image_link>${mainImage}</g:image_link>
      ${adImage && adImage !== mainImage ? `<g:additional_image_link>${adImage}</g:additional_image_link>` : ''}
      <g:price>${parseFloat(v.price).toFixed(2)} USD</g:price>
      <g:availability>${availability}</g:availability>
      <g:condition>new</g:condition>
      <g:brand>${brand.replace(/&/g, '&amp;')}</g:brand>
      <g:google_product_category>${googleCategory}</g:google_product_category>
      <g:identifier_exists>no</g:identifier_exists>
      <g:mpn>${sku}</g:mpn>
      <g:shipping>
        <g:country>US</g:country>
        <g:service>Standard</g:service>
        <g:price>8.99 USD</g:price>
      </g:shipping>
    </item>`;
    }
  }

  xml += `
  </channel>
</rss>`;

  return xml;
}

// ─── 라우트 ─────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Shopify Webhook Server v4 (HyperCape Edition)',
    logic: 'Auto-generates product description + Facebook ad image (DALL-E). Original product images untouched.',
    openai: process.env.OPENAI_API_KEY ? 'set' : 'missing',
    shopify: SHOPIFY_STORE || 'missing',
    catalog_feed: `https://${process.env.RAILWAY_STATIC_URL || 'shopify-shipping-webhook-production.up.railway.app'}/catalog.xml`,
    time: new Date().toISOString()
  });
});

let catalogCache = { xml: null, generatedAt: 0 };
const CACHE_TTL_MS = 60 * 60 * 1000;

app.get('/catalog.xml', async (req, res) => {
  const now = Date.now();
  const forceRefresh = req.query.refresh === '1';

  if (!forceRefresh && catalogCache.xml && (now - catalogCache.generatedAt) < CACHE_TTL_MS) {
    console.log('[Catalog] Serving cached feed');
  } else {
    console.log('[Catalog] Generating fresh feed from Shopify...');
    try {
      catalogCache.xml = await buildFacebookCatalogFeed();
      catalogCache.generatedAt = now;
      console.log('[Catalog] ✅ Feed generated');
    } catch (err) {
      console.error('[Catalog] Error:', err.message);
      return res.status(500).send('Feed generation failed');
    }
  }

  res.setHeader('Content-Type', 'application/rss+xml; charset=UTF-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(catalogCache.xml);
});

app.get('/catalog.json', async (req, res) => {
  const r = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=250&status=active`,
    { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
  );
  const { products } = await r.json();

  const items = [];
  for (const p of products) {
    if (p.tags?.includes('shipping-fee-hidden') || p.handle === 'shipping-fee') continue;
    for (const v of p.variants) {
      const inStock = v.inventory_policy === 'continue' || (v.inventory_quantity ?? 0) > 0;
      items.push({
        id: `shopify_US_${p.id}_${v.id}`,
        title: p.title + (v.title !== 'Default Title' ? ` - ${v.title}` : ''),
        description: (p.body_html || '').replace(/<[^>]*>/g, '').trim().substring(0, 1000),
        availability: inStock ? 'in stock' : 'out of stock',
        condition: 'new',
        price: `${parseFloat(v.price).toFixed(2)} USD`,
        link: `https://sojudad.com/products/${p.handle}`,
        image_link: p.images?.[0]?.src || '',
        brand: p.vendor || 'Korean Brand',
      });
    }
  }
  res.json({ data: items });
});

// 제품 생성 웹훅
app.post('/webhook/product-create', async (req, res) => {
  res.sendStatus(200);
  const product = req.body;
  if (!product?.id) return;
  await processProduct(product);
  catalogCache = { xml: null, generatedAt: 0 };
  console.log('[Catalog] Cache invalidated after product-create');
});

// 제품 업데이트 웹훅
app.post('/webhook/product-update', async (req, res) => {
  res.sendStatus(200);
  const product = req.body;
  if (!product?.id) return;
  catalogCache = { xml: null, generatedAt: 0 };
  const existing = (product.body_html || '').replace(/<[^>]*>/g, '').trim();
  if (existing.length > 150) return;
  await processProduct(product);
});

// 백필: 기존 제품 설명 채우기
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
  console.log(`   FB Image: DALL-E 3 (no canvas dependency)`);
  console.log(`   Catalog : /catalog.xml (Meta Business Manager용 피드)\n`);
});

export default app;
