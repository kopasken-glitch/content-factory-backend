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
      if (typeof c.text === 'string') chunks.push(c.text);
      if (typeof c.content === 'string') chunks.push(c.content);
      if (c.type === 'output_text' && typeof c.text === 'string') chunks.push(c.text);
    }
  }
  return chunks.join('\n').trim();
}

function extractJsonObject(text) {
  const cleaned = String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const sliced = cleaned.slice(first, last + 1);
    try {
      return JSON.parse(sliced);
    } catch (_) {}
  }

  return null;
}

function normalizeSceneObject(scene, index) {
  return {
    scene: Number(scene.scene || scene.number || index + 1),
    duration: Number(scene.duration || scene.durationSeconds || scene.seconds || 6),
    narration: String(scene.narration || scene.voiceover || scene.line || ''),
    visual: String(scene.visual || scene.description || ''),
    imagePrompt: String(scene.imagePrompt || scene.image_prompt || scene.prompt || scene.visual || ''),
    videoPrompt: String(scene.videoPrompt || scene.video_prompt || scene.motionPrompt || scene.imagePrompt || scene.visual || ''),
    onScreenText: String(scene.onScreenText || scene.on_screen_text || scene.text || '')
  };
}

function normalizeStoryboardPayload(payload, fallbackText = '') {
  if (!payload || typeof payload !== 'object') return null;
  const rawScenes = Array.isArray(payload.scenes) ? payload.scenes : [];
  const scenes = rawScenes.map(normalizeSceneObject).filter((s) => s.imagePrompt || s.visual || s.narration);

  if (!scenes.length) return null;

  return {
    title: String(payload.title || 'Generated storyboard'),
    totalDuration: Number(payload.totalDuration || payload.total_duration || scenes.reduce((sum, s) => sum + Number(s.duration || 0), 0) || 30),
    script: String(payload.script || payload.narration || fallbackText || scenes.map((s) => s.narration).filter(Boolean).join(' ')),
    scenes
  };
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

    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'totalDuration', 'script', 'scenes'],
      properties: {
        title: { type: 'string' },
        totalDuration: { type: 'number' },
        script: { type: 'string' },
        scenes: {
          type: 'array',
          minItems: 3,
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['scene', 'duration', 'narration', 'visual', 'imagePrompt', 'videoPrompt', 'onScreenText'],
            properties: {
              scene: { type: 'number' },
              duration: { type: 'number' },
              narration: { type: 'string' },
              visual: { type: 'string' },
              imagePrompt: { type: 'string' },
              videoPrompt: { type: 'string' },
              onScreenText: { type: 'string' }
            }
          }
        }
      }
    };

    const prompt = `
Create a short vertical UGC video storyboard for a US audience.

User idea:
${idea}

Before writing the storyboard, use web search internally to understand successful YouTube videos on similar topics. Prefer patterns from videos that appear popular or have 100,000+ views when that information is publicly visible.
Do not output links, research notes, citations, or analytics. Use only the best practices: hook, pacing, visual pattern, retention structure, and CTA.

Rules:
- Language of narration: natural conversational American English.
- Decide the number of scenes yourself.
- Decide each scene duration yourself.
- Do not make all scenes the same length.
- If the user mentions a target duration, stay close to it. Otherwise aim for about 30 seconds.
- Usually use 5-10 scenes for 25-45 seconds.
- First 1-3 seconds must be a strong hook.
- Keep scenes simple enough for image/video generation.
- imagePrompt must be in English and must describe: action, environment, outfit, camera angle, lighting, mood, depth of field. Do not describe exact facial identity because reference images define the character.
- videoPrompt must describe camera movement and subject motion for the same scene.
- Return only data matching the schema.`;

    const requestBody = {
      model,
      input: [
        {
          role: 'system',
          content: 'You are a senior short-form UGC scriptwriter, storyboard director, and YouTube research analyst. Return only valid structured storyboard data.'
        },
        { role: 'user', content: prompt }
      ],
      max_output_tokens: 5000,
      text: {
        format: {
          type: 'json_schema',
          name: 'storyboard_response',
          strict: true,
          schema
        }
      }
    };

    // Web search is useful, but structured JSON is more important.
    // If this account/model rejects the search tool, the fallback request below runs without it.
    let response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${requireEnv('OPENAI_API_KEY')}`
      },
      body: JSON.stringify({
        ...requestBody,
        tools: [{ type: 'web_search_preview' }]
      })
    });

    if (!response.ok) {
      const firstErrorText = await response.text().catch(() => '');
      console.warn('OpenAI request with web search failed, retrying without web search:', firstErrorText.slice(0, 800));

      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${requireEnv('OPENAI_API_KEY')}`
        },
        body: JSON.stringify(requestBody)
      });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OpenAI ${response.status}: ${text.slice(0, 2000)}`);
    }

    const data = await response.json();
    const text = parseOpenAIText(data);
    const rawParsed = extractJsonObject(text);
    const parsed = normalizeStoryboardPayload(rawParsed, text);

    if (!parsed) {
      console.error('OpenAI did not return usable storyboard:', JSON.stringify(data).slice(0, 5000));
      return res.status(500).json({
        ok: false,
        error: 'OpenAI did not return a usable scenes array. Try a more specific idea.',
        text
      });
    }

    res.json({ ok: true, text: JSON.stringify(parsed, null, 2), parsed });
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
