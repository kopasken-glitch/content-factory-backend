import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const PORT = process.env.PORT || 10000;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'content-assets';

app.use(cors({ origin: true }));
app.use(express.json({ limit: '80mb' }));
app.use(express.urlencoded({ extended: true, limit: '80mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

const supabase = createClient(
  requireEnv('SUPABASE_URL'),
  requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false } }
);

function safeExtFromMime(mime = '') {
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('mp4')) return 'mp4';
  return 'bin';
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid data URL');
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64')
  };
}

function buildPublicUrl(filePath) {
  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(filePath);
  return data.publicUrl;
}

async function uploadBufferToSupabase(buffer, mimeType, folder = 'uploads') {
  const ext = safeExtFromMime(mimeType);
  const filePath = `${folder}/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(filePath, buffer, {
    contentType: mimeType || 'application/octet-stream',
    upsert: false
  });

  if (error) throw new Error(`Supabase upload error: ${error.message}`);

  return {
    path: filePath,
    url: buildPublicUrl(filePath)
  };
}

async function ensurePublicImageUrl(input, folder = 'references') {
  if (!input) throw new Error('Image is empty');
  if (typeof input === 'string' && input.startsWith('http')) return input;
  if (typeof input === 'string' && input.startsWith('data:')) {
    const { buffer, mimeType } = dataUrlToBuffer(input);
    const uploaded = await uploadBufferToSupabase(buffer, mimeType, folder);
    return uploaded.url;
  }
  throw new Error('Unsupported image format. Use public URL or data URL.');
}

async function segmindPost(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': requireEnv('SEGMIND_API_KEY')
    },
    body: JSON.stringify(body)
  });

  const contentType = res.headers.get('content-type') || '';

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Segmind ${res.status}: ${text.slice(0, 2000)}`);
  }

  if (contentType.includes('application/json')) {
    return { type: 'json', data: await res.json(), contentType };
  }

  const arrayBuffer = await res.arrayBuffer();
  return { type: 'binary', buffer: Buffer.from(arrayBuffer), contentType };
}

function extractUrlFromJson(data) {
  if (!data) return null;
  if (typeof data === 'string' && data.startsWith('http')) return data;
  if (data.url) return data.url;
  if (data.image_url) return data.image_url;
  if (data.video_url) return data.video_url;
  if (data.output) return Array.isArray(data.output) ? data.output[0] : data.output;
  if (data.outputs) return Array.isArray(data.outputs) ? data.outputs[0] : data.outputs;
  if (data.data?.url) return data.data.url;
  return null;
}

function extractBase64FromJson(data) {
  if (!data) return null;
  if (data.image && typeof data.image === 'string') return data.image;
  if (data.video && typeof data.video === 'string') return data.video;
  if (data.base64 && typeof data.base64 === 'string') return data.base64;
  return null;
}

function parseOpenAIText(data) {
  if (data.output_text) return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const c of item.content || []) {
      if (c.text) chunks.push(c.text);
      if (c.type === 'output_text' && c.text) chunks.push(c.text);
    }
  }
  return chunks.join('\n').trim();
}

app.get('/api/health', async (req, res) => {
  try {
    const missing = ['OPENAI_API_KEY', 'SEGMIND_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_BUCKET']
      .filter((name) => !process.env[name]);

    res.json({
      ok: missing.length === 0,
      missing,
      bucket: SUPABASE_BUCKET,
      service: 'content-factory-backend'
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/upload-image', upload.single('file'), async (req, res) => {
  try {
    if (req.file) {
      const uploaded = await uploadBufferToSupabase(req.file.buffer, req.file.mimetype, req.body.folder || 'uploads');
      return res.json({ ok: true, ...uploaded });
    }

    const { dataUrl, folder = 'uploads' } = req.body;
    const { buffer, mimeType } = dataUrlToBuffer(dataUrl);
    const uploaded = await uploadBufferToSupabase(buffer, mimeType, folder);
    res.json({ ok: true, ...uploaded });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/generate-script', async (req, res) => {
  try {
    const { idea, model = 'gpt-4.1-mini' } = req.body;
    if (!idea) return res.status(400).json({ ok: false, error: 'Idea is required' });

    const prompt = `
Ты создаёшь сценарий короткого вертикального UGC-видео для американской аудитории.

Сначала скрыто сделай research по YouTube: найди похожие популярные видео и темы, ориентируйся на видео с 100000+ просмотров, если просмотры доступны в публичных данных.
Не показывай пользователю research, ссылки и источники. Используй только выводы: хук, темп, структура, визуальные паттерны, удержание, CTA.

Пользовательская идея:
${idea}

Требования:
- Определи количество сцен самостоятельно.
- Определи длительность каждой сцены самостоятельно.
- Не делай одинаковую длительность всех сцен.
- Обычно 5-10 сцен для ролика 25-45 секунд.
- Первые 1-3 секунды должны быть сильным хуком.
- Язык сценария: английский, естественный американский разговорный стиль.
- Не копируй чужие формулировки.
- Верни ответ строго в JSON без markdown.

Формат JSON:
{
  "title": "...",
  "totalDuration": 30,
  "script": "full narration text",
  "scenes": [
    {
      "scene": 1,
      "duration": 3,
      "narration": "...",
      "visual": "...",
      "imagePrompt": "...",
      "videoPrompt": "...",
      "onScreenText": "..."
    }
  ]
}
`;

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${requireEnv('OPENAI_API_KEY')}`
      },
      body: JSON.stringify({
        model,
        tools: [{ type: 'web_search' }],
        input: [
          {
            role: 'system',
            content: 'Ты профессиональный сценарист коротких вертикальных UGC-видео, режиссёр и YouTube research analyst. Финально отвечай только валидным JSON.'
          },
          { role: 'user', content: prompt }
        ],
        max_output_tokens: 5000
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OpenAI ${response.status}: ${text.slice(0, 2000)}`);
    }

    const data = await response.json();
    const text = parseOpenAIText(data);

    let parsed = null;
    try {
      parsed = JSON.parse(text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim());
    } catch (_) {}

    res.json({ ok: true, text, parsed });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/generate-image', async (req, res) => {
  try {
    const {
      prompt,
      referenceImages = [],
      model = 'nano-banana-pro',
      aspectRatio = '9:16',
      outputResolution = '1K'
    } = req.body;

    if (!prompt) return res.status(400).json({ ok: false, error: 'Prompt is required' });

    const referenceUrls = [];
    for (const img of referenceImages) {
      referenceUrls.push(await ensurePublicImageUrl(img, 'references'));
    }

    const endpoint = `https://api.segmind.com/v1/${model}`;
    const body = {
      prompt,
      image_urls: referenceUrls,
      aspect_ratio: aspectRatio,
      output_format: 'png',
      output_resolution: outputResolution,
      seed: Math.floor(Math.random() * 999999)
    };

    const result = await segmindPost(endpoint, body);

    if (result.type === 'binary') {
      const uploaded = await uploadBufferToSupabase(result.buffer, result.contentType || 'image/png', 'generated-images');
      return res.json({ ok: true, url: uploaded.url, path: uploaded.path, referenceUrls });
    }

    const url = extractUrlFromJson(result.data);
    if (url) return res.json({ ok: true, url, raw: result.data, referenceUrls });

    const b64 = extractBase64FromJson(result.data);
    if (b64) {
      const buffer = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      const uploaded = await uploadBufferToSupabase(buffer, 'image/png', 'generated-images');
      return res.json({ ok: true, url: uploaded.url, path: uploaded.path, raw: result.data, referenceUrls });
    }

    throw new Error('Unknown Segmind image response format');
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/generate-video', async (req, res) => {
  try {
    const {
      prompt,
      image,
      duration = 8,
      model = 'veo-3.1-fast',
      aspectRatio = '9:16',
      resolution = '1080p',
      generateAudio = true
    } = req.body;

    if (!prompt) return res.status(400).json({ ok: false, error: 'Prompt is required' });
    if (!image) return res.status(400).json({ ok: false, error: 'Image URL or data URL is required' });

    const imageUrl = await ensurePublicImageUrl(image, 'video-inputs');
    const endpoint = `https://api.segmind.com/v1/${model}`;
    const body = {
      prompt,
      image: imageUrl,
      duration: Number(duration),
      resolution,
      aspect_ratio: aspectRatio,
      generate_audio: Boolean(generateAudio),
      seed: Math.floor(Math.random() * 999999)
    };

    const result = await segmindPost(endpoint, body);

    if (result.type === 'binary') {
      const uploaded = await uploadBufferToSupabase(result.buffer, result.contentType || 'video/mp4', 'generated-videos');
      return res.json({ ok: true, url: uploaded.url, path: uploaded.path, imageUrl });
    }

    const url = extractUrlFromJson(result.data);
    if (url) return res.json({ ok: true, url, raw: result.data, imageUrl });

    const b64 = extractBase64FromJson(result.data);
    if (b64) {
      const buffer = Buffer.from(b64.replace(/^data:video\/\w+;base64,/, ''), 'base64');
      const uploaded = await uploadBufferToSupabase(buffer, 'video/mp4', 'generated-videos');
      return res.json({ ok: true, url: uploaded.url, path: uploaded.path, raw: result.data, imageUrl });
    }

    if (result.data?.id || result.data?.job_id) {
      return res.json({ ok: true, jobId: result.data.id || result.data.job_id, raw: result.data, imageUrl });
    }

    throw new Error('Unknown Segmind video response format');
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Content Factory backend is running on port ${PORT}`);
});
