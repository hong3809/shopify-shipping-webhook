import express from 'express';
import OpenAI from 'openai';
import fetch from 'node-fetch';

const app = express();
app.use(express.json({ limit: '10mb' }));

const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env['오픈아이_API_키'],
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
});

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_URL || process.env['쇼피파이 스토어 URL'];
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;

function detectProductCategory(product) {
  const title = (product.title || '').toLowerCase();
  const tags  = (product.tags  || '').toLowerCase();
  const combined = title + ' ' + tags;

  if (combined.match(/album|mini album|kpop|k-pop|blackpink|bts|aespa|twice|ive|newjeans|stray kids|le sserafim|lightstick|photocard/)) return 'kpop';
  if (combined.match(/sunscreen|suncare|spf|uv protection|sun cream/))                       return 'suncare';
  if (combined.match(/cleanser|cleansing|foam cleanser|face wash|micellar|cleansing oil/))   return 'cleansing';
  if (combined.match(/toner|serum|essence|ampoule/))                                         return 'toner-serum';
  if (combined.match(/sheet mask|face mask|sleeping mask|pimple patch|eye patch|glow mask|honey mask|rice mask|ground rice/)) return 'masks-patches';
  if (combined.match(/makeup|foundation|cushion|bb cream|lip |lipstick|blush|eyeshadow/))   return 'makeup';
  if (combined.match(/shampoo|conditioner|hair mask|hair treatment|scalp/))                  return 'hair-care';
  if (combined.match(/body lotion|body wash|body cream|hand cream/))                         return 'body-care';
  if (combined.match(/led mask|face roller|gua sha|dermaroller|beauty device/))              return 'beauty-device';
  return 'skincare';
}

function extractHowToUse(html) {
  if (!html) return null;

  const patterns = [
    /<h[1-4][^>]*>[^<]*(?:how to use|how to apply|directions|usage|사용 방법|사용방법|사용법)[^<]*<\/h[1-4]>([\s\S]*?)(?=<h[1-4]|$)/i,
    /<strong>[^<]*(?:how to use|how to apply|directions|usage)[^<]*<\/strong>([\s\S]*?)(?=<strong>|<h[1-4]|$)/i,
    /<p>[^<]*(?:how to use|how to apply|directions|usage)[^<]*:([^<]*)<\/p>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      const text = match[0].replace(/<[^>]+>/g, '').trim();
      if (text.length >= 30) {
        return { found: true, html: match[0], text };
      }
    }
  }
  return null;
}

function scoreHowToUse(text) {
  if (!text) return 0;
  let score = 0;

  score += Math.min(text.length / 10, 30);

  const steps = (text.match(/(?:step\s*\d+|\d+[\.\)]\s)/gi) || []).length;
  score += steps * 8;

  const actionVerbs = text.match(/\b(?:apply|massage|pat|rinse|cleanse|spread|gently|use|take|pump|dispense|leave on|wash off)\b/gi) || [];
  score += actionVerbs.length * 5;

  const englishRatio = (text.match(/[a-zA-Z]/g) || []).length / Math.max(text.length, 1);
  if (englishRatio > 0.7) score += 10;

  return score;
}

async function generateHowToUse(product) {
  const category = detectProductCategory(product);
  const title    = product.title  || 'K-Beauty Product';
  const vendor   = product.vendor || 'Korean Brand';

  const existingInfo = (product.body_html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .substring(0, 400)
    .trim();

  const categoryContext = {
    'kpop':         'K-Pop album or merchandise (not a skincare product – skip skincare steps)',
    'suncare':      'Korean sunscreen / sun protection product',
    'cleansing':    'Korean facial cleanser',
    'toner-serum':  'Korean toner or serum',
    'masks-patches':'Korean sheet mask or patch',
    'makeup':       'Korean makeup product',
    'hair-care':    'Korean hair care product',
    'body-care':    'Korean body care product',
    'beauty-device':'Korean beauty device or tool',
    'skincare':     'Korean skincare product',
  };

  const systemPrompt = `You are a K-Beauty product expert. 
Your ONLY task is to write a "How to Use" section in clean HTML.
Do NOT write a full product description — only the How to Use part.`;

  const userPrompt = `Write ONLY a "How to Use" section for this product.

Product: ${title}
Brand: ${vendor}
Type: ${categoryContext[category] || 'Korean beauty product'}
${existingInfo ? `Product Info: ${existingInfo}` : ''}

Rules:
1. English only (international customers)
2. Output clean HTML: <h3>How to Use</h3> followed by <ol><li>...</li></ol>
3. 3–6 numbered steps, each step 1–2 sentences
4. Be specific and practical (amounts, timing, technique)
5. DO NOT include intro, features, ingredients, or who-it's-for — ONLY the steps
6. Return ONLY the HTML, no explanation

Example format:
<h3>How to Use</h3>
<ol>
  <li>Step text here.</li>
  <li>Step text here.</li>
</ol>`;

  try {
    const completion = await openaiClient.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   }
      ],
      max_tokens: 400,
      temperature: 0.5
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('[OpenAI] Error generating How to Use:', error.message);
    return null;
  }
}

function removeHowToUseSection(html) {
  if (!html) return html;
  return html.replace(
    /<h[1-4][^>]*>[^<]*(?:how to use|how to apply|directions|usage|사용 방법|사용방법|사용법)[^<]*<\/h[1-4]>([\s\S]*?)(?=<h[1-4]|$)/i,
    ''
  ).trim();
}

async function updateShopifyProduct(productId, updateData) {
  const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/products/${productId}.json`;
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ product: updateData })
    });
    if (!response.ok) {
      console.error(`[Shopify] Update failed (${response.status}):`, await response.text());
      return false;
    }
    return true;
  } catch (error) {
    console.error('[Shopify] Fetch error:', error.message);
    return false;
  }
}

async function processProduct(product) {
  const productId    = product.id;
  const title        = product.title || '';
  const existingHtml = product.body_html || '';

  console.log(`\n[Process] ▶ ${title} (ID: ${productId})`);

  // 1. HyperCape에서 넘어온 How to Use 섹션 감지
  const hypercapeHowTo = extractHowToUse(existingHtml);
  const hcScore = hypercapeHowTo ? scoreHowToUse(hypercapeHowTo.text) : 0;

  if (hypercapeHowTo) {
    console.log(`[Process] HyperCape How to Use 감지됨 (${hypercapeHowTo.text.length}자, 점수: ${hcScore})`);
  } else {
    console.log(`[Process] HyperCape How to Use 없음 → OpenAI 생성`);
  }

  // 2. OpenAI로 How to Use 생성
  const aiHowToHtml = await generateHowToUse(product);
  if (!aiHowToHtml) {
    console.log(`[Process] OpenAI 생성 실패 → 업데이트 스킵`);
    return;
  }

  const aiText  = aiHowToHtml.replace(/<[^>]+>/g, ' ').trim();
  const aiScore = scoreHowToUse(aiText);
  console.log(`[Process] OpenAI How to Use 생성됨 (${aiText.length}자, 점수: ${aiScore})`);

  // 3. 어느 것을 사용할지 결정
  let finalHowToHtml;
  if (!hypercapeHowTo) {
    // HyperCape 사용법 없음 → AI 것 사용
    finalHowToHtml = aiHowToHtml;
    console.log(`[Decision] ✅ OpenAI How to Use 사용 (HyperCape 없음)`);
  } else if (aiScore > hcScore + 5) {
    // AI 점수가 5점 이상 높으면 교체
    finalHowToHtml = aiHowToHtml;
    console.log(`[Decision] ✅ OpenAI How to Use 교체 (AI ${aiScore}점 > HyperCape ${hcScore}점)`);
  } else {
    // HyperCape 것 유지
    console.log(`[Decision] ✅ HyperCape How to Use 유지 (HyperCape ${hcScore}점 >= AI ${aiScore}점)`);
    return;
  }

  // 4. 기존 설명 보존 + How to Use만 교체/추가
  const baseHtml  = removeHowToUseSection(existingHtml);
  const finalHtml = baseHtml
    ? baseHtml + '\n\n' + finalHowToHtml
    : finalHowToHtml;

  // 5. Shopify 업데이트
  const success = await updateShopifyProduct(productId, { body_html: finalHtml });
  console.log(success
    ? `[Success] ✅ How to Use 업데이트 완료: ${title}`
    : `[Error]   ❌ 업데이트 실패: ${title}`
  );
}

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Shopify Webhook Server v4 (HyperCape Edition)',
    logic: 'Preserves HyperCape description, adds/replaces How to Use section only',
    openai: process.env.OPENAI_API_KEY || process.env['오픈아이_API_키'] ? 'set' : 'missing',
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
  await processProduct(product);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 HyperCape Webhook Server v4 running on port ${PORT}`);
  console.log(`   Store: ${SHOPIFY_STORE}`);
  console.log(`   OpenAI: ${process.env.OPENAI_API_KEY || process.env['오픈아이_API_키'] ? '✅' : '❌'}`);
  console.log(`   Logic: HyperCape 설명 보존 + How to Use만 AI로 자동 추가/교체`);
});
