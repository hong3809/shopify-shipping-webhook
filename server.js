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
  const tags = (product.tags || '').toLowerCase();
  const combined = title + ' ' + tags;

  if (combined.match(/album|mini album|kpop|k-pop|blackpink|bts|aespa|twice|ive|newjeans|stray kids|le sserafim|lightstick|photocard/)) return 'kpop';
  if (combined.match(/sunscreen|suncare|spf|uv protection|sun cream/)) return 'suncare';
  if (combined.match(/cleanser|cleansing|foam cleanser|face wash|micellar|cleansing oil/)) return 'cleansing';
  if (combined.match(/toner|serum|essence|ampoule/)) return 'toner-serum';
  if (combined.match(/sheet mask|face mask|sleeping mask|pimple patch|eye patch|glow mask|honey mask|rice mask|ground rice/)) return 'masks-patches';
  if (combined.match(/makeup|foundation|cushion|bb cream|lip |lipstick|blush|eyeshadow/)) return 'makeup';
  if (combined.match(/shampoo|conditioner|hair mask|hair treatment|scalp/)) return 'hair-care';
  if (combined.match(/body lotion|body wash|body cream|hand cream/)) return 'body-care';
  if (combined.match(/led mask|face roller|gua sha|dermaroller|beauty device/)) return 'beauty-device';
  return 'skincare';
}

async function generateProductDescription(product) {
  const category = detectProductCategory(product);
  const title = product.title || 'K-Beauty Product';
  const vendor = product.vendor || 'Korean Brand';
  const existingDesc = (product.body_html || '').replace(/<[^>]*>/g, '').substring(0, 300);

  const categoryPrompts = {
    'kpop': 'You are a K-Pop merchandise expert copywriter. Write an engaging, fan-focused product description.',
    'suncare': 'You are a K-Beauty sunscreen expert. Emphasize SPF protection, skin benefits, Korean formulation technology.',
    'cleansing': 'You are a K-Beauty skincare expert specializing in cleansers.',
    'toner-serum': 'You are a K-Beauty skincare expert specializing in toners and serums.',
    'masks-patches': 'You are a K-Beauty expert specializing in masks and patches.',
    'makeup': 'You are a K-Beauty makeup expert.',
    'hair-care': 'You are a K-Beauty hair care expert.',
    'body-care': 'You are a K-Beauty body care expert.',
    'beauty-device': 'You are a K-Beauty device expert.',
    'skincare': 'You are a K-Beauty skincare expert.'
  };

  const userPrompt = `
Write a compelling Shopify product description for this Korean product:

Product Title: ${title}
Brand: ${vendor}
Category: ${category}
Existing Info: ${existingDesc || 'No existing description'}

Requirements:
1. Write in English for international customers
2. Use clean HTML only (<h3>, <p>, <ul>, <li>, <strong>)
3. Structure: intro → Key Features (4-6 bullets) → How to Use (numbered) → Who It's For
4. Total: 250-400 words
5. Tone: Professional yet approachable
6. Include K-beauty SEO keywords
7. No prices or availability mentions

Return ONLY the HTML content.
`;

  try {
    const completion = await openaiClient.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: categoryPrompts[category] || categoryPrompts['skincare'] },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 800,
      temperature: 0.7
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('[OpenAI] Error:', error.message);
    return null;
  }
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
    return response.ok;
  } catch (error) {
    console.error('[Shopify] Error:', error.message);
    return false;
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Shopify Webhook Server v3 (HyperCape Edition)',
    openai: process.env.OPENAI_API_KEY ? 'set' : 'missing',
    time: new Date().toISOString()
  });
});

// 제품 생성 webhook
app.post('/webhook/product-create', async (req, res) => {
  res.sendStatus(200);
  const product = req.body;
  if (!product?.id) return;

  console.log(`[Webhook] Product created: ${product.id} - ${product.title}`);

  const existingDesc = (product.body_html || '').replace(/<[^>]*>/g, '').trim();
  if (existingDesc.length > 100) {
    console.log(`[Webhook] Already has description, skipping`);
    return;
  }

  const description = await generateProductDescription(product);
  if (!description) return;

  const success = await updateShopifyProduct(product.id, { body_html: description });
  console.log(success ? `✅ Description updated: ${product.title}` : `❌ Failed: ${product.title}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 HyperCape Webhook Server v3 running on port ${PORT}`);
  console.log(`   Store: ${SHOPIFY_STORE}`);
  console.log(`   OpenAI: ${process.env.OPENAI_API_KEY ? '✅' : '❌'}`);
});
