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
const SUPABASE_BUCKET = String(process.env.SUPABASE_BUCKET || 'content-assets').trim().replace(/^\/+|\/+$/g, '');

const CREATORS = {
  michael: { slug: 'michael', name: 'Майкл' },
  sara: { slug: 'sara', name: 'Сара' },
  rob: { slug: 'rob', name: 'Роб' },
  emily: { slug: 'emily', name: 'Эмили' }
};

function normalizeCreatorSlug(value = 'michael') {
  const slug = String(value || 'michael').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return CREATORS[slug] ? slug : 'michael';
}

function creatorFolder(creatorSlug, assetType = 'uploads') {
  const slug = normalizeCreatorSlug(creatorSlug);
  const type = sanitizeStorageSegment(assetType || 'uploads');
  return `creators/${slug}/${type}`;
}

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

function sanitizeStorageSegment(value = 'uploads') {
  return String(value || 'uploads')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\\/g, '/')
    .replace(/[^a-zA-Z0-9/_-]/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '') || 'uploads';
}

function normalizeStoragePath(filePath) {
  return String(filePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .split('/')
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'file')
    .join('/');
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
  const safeFolder = sanitizeStorageSegment(folder);
  const dateFolder = new Date().toISOString().slice(0, 10);
  const fileName = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const filePath = normalizeStoragePath(`${safeFolder}/${dateFolder}/${fileName}`);

  if (!filePath || filePath.startsWith('/') || filePath.includes('//')) {
    throw new Error(`Invalid normalized Supabase path: ${filePath}`);
  }

  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(filePath, buffer, {
    contentType: mimeType || 'application/octet-stream',
    upsert: true
  });

  if (error) {
    throw new Error(`Supabase upload error: ${error.message}. bucket=${SUPABASE_BUCKET}; path=${filePath}`);
  }

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


function normalizeChatRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    idea: row.idea,
    script: row.script || '',
    scenes: row.scenes || [],
    assets: row.assets || {},
    status: row.status || 'draft',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function createChatRecord({ title, creatorSlug, creatorName, idea, script = '', scenes = [], assets = {}, status = 'draft' }) {
  const selectedCreatorSlug = normalizeCreatorSlug(creatorSlug);
  const selectedCreatorName = creatorName || CREATORS[selectedCreatorSlug]?.name || selectedCreatorSlug;
  const { data, error } = await supabase
    .from('chats')
    .insert({
      title: title || String(idea || 'Untitled chat').slice(0, 80) || 'Untitled chat',
      creator_id: selectedCreatorSlug,
      creator_name: selectedCreatorName,
      idea: idea || '',
      script: script || '',
      scenes: Array.isArray(scenes) ? scenes : [],
      assets: assets && typeof assets === 'object' ? assets : {},
      status
    })
    .select('*')
    .single();

  if (error) throw new Error(`Supabase chats insert error: ${error.message}`);
  return normalizeChatRow(data);
}

async function updateChatRecord(id, payload = {}) {
  const update = { updated_at: new Date().toISOString() };
  if (payload.title !== undefined) update.title = payload.title;
  if (payload.creatorSlug !== undefined) update.creator_id = normalizeCreatorSlug(payload.creatorSlug);
  if (payload.creatorName !== undefined) update.creator_name = payload.creatorName;
  if (payload.idea !== undefined) update.idea = payload.idea;
  if (payload.script !== undefined) update.script = payload.script;
  if (payload.scenes !== undefined) update.scenes = Array.isArray(payload.scenes) ? payload.scenes : [];
  if (payload.assets !== undefined) update.assets = payload.assets && typeof payload.assets === 'object' ? payload.assets : {};
  if (payload.status !== undefined) update.status = payload.status;

  const { data, error } = await supabase
    .from('chats')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw new Error(`Supabase chats update error: ${error.message}`);
  return normalizeChatRow(data);
}

app.get('/api/chats', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 100);
    const creatorSlug = req.query.creatorSlug ? normalizeCreatorSlug(req.query.creatorSlug) : null;
    let query = supabase
      .from('chats')
      .select('id,title,creator_id,creator_name,idea,status,created_at,updated_at')
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (creatorSlug) query = query.eq('creator_id', creatorSlug);
    const { data, error } = await query;
    if (error) throw new Error(`Supabase chats list error: ${error.message}`);
    res.json({ ok: true, chats: (data || []).map(normalizeChatRow) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/chats/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('chats').select('*').eq('id', req.params.id).single();
    if (error) throw new Error(`Supabase chat read error: ${error.message}`);
    res.json({ ok: true, chat: normalizeChatRow(data) });
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message });
  }
});

app.post('/api/chats', async (req, res) => {
  try {
    const chat = await createChatRecord(req.body || {});
    res.json({ ok: true, chat });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.patch('/api/chats/:id', async (req, res) => {
  try {
    const chat = await updateChatRecord(req.params.id, req.body || {});
    res.json({ ok: true, chat });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.delete('/api/chats/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('chats').delete().eq('id', req.params.id);
    if (error) throw new Error(`Supabase chat delete error: ${error.message}`);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const missing = ['OPENAI_API_KEY', 'SEGMIND_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_BUCKET']
      .filter((name) => !process.env[name]);

    res.json({
      ok: missing.length === 0,
      missing,
      bucket: SUPABASE_BUCKET,
      service: 'content-factory-backend',
      version: 'v7-chats-autosave',
      creators: Object.values(CREATORS)
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/upload-image', upload.single('file'), async (req, res) => {
  try {
    if (req.file) {
      const creatorSlug = normalizeCreatorSlug(req.body.creatorSlug || req.body.creator || 'michael');
      const assetType = req.body.assetType || req.body.folder || 'uploads';
      const uploaded = await uploadBufferToSupabase(req.file.buffer, req.file.mimetype, creatorFolder(creatorSlug, assetType));
      return res.json({ ok: true, ...uploaded });
    }

    const { dataUrl, folder = 'uploads', assetType, creatorSlug = 'michael' } = req.body;
    const { buffer, mimeType } = dataUrlToBuffer(dataUrl);
    const uploaded = await uploadBufferToSupabase(buffer, mimeType, creatorFolder(creatorSlug, assetType || folder));
    res.json({ ok: true, ...uploaded });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/generate-script', async (req, res) => {
  try {
    const { idea, model = 'gpt-4.1-mini', creatorSlug = 'michael', creatorName } = req.body;
    const selectedCreatorSlug = normalizeCreatorSlug(creatorSlug);
    const selectedCreatorName = creatorName || CREATORS[selectedCreatorSlug]?.name || selectedCreatorSlug;
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

    const system = 'You are a senior short-form UGC scriptwriter and storyboard director for US social video. You always return strict JSON only.';
    const userPrompt = `
Create a short vertical UGC video storyboard for a US audience.

Selected AI blogger / character: ${selectedCreatorName} (${selectedCreatorSlug}).
All visual references uploaded by the user belong to this character, so keep continuity with that character.

User idea:
${idea}

Use the patterns of successful short-form YouTube/TikTok/Reels content: immediate hook, personal angle, simple visual action, fast pacing, clear payoff, and a light CTA. Do not output research notes or links.

Rules:
- Narration must be natural conversational American English.
- Decide the number of scenes yourself.
- Decide each scene duration yourself.
- Do not make all scenes the same length.
- If the user mentions a target duration, stay close to it. Otherwise aim for about 30 seconds.
- Usually use 5-10 scenes for 25-45 seconds.
- First 1-3 seconds must be a strong hook.
- Keep scenes simple enough for image/video generation.
- imagePrompt must be in English and must describe: action, environment, outfit, camera angle, lighting, mood, depth of field. Do not describe exact facial identity because reference images define the character.
- videoPrompt must describe camera movement and subject motion for the same scene.

Return strictly this JSON shape:
{
  "title": "string",
  "totalDuration": number,
  "script": "string",
  "scenes": [
    {
      "scene": number,
      "duration": number,
      "narration": "string",
      "visual": "string",
      "imagePrompt": "string",
      "videoPrompt": "string",
      "onScreenText": "string"
    }
  ]
}`;

    async function callResponsesWithSchema(useSearch) {
      const body = {
        model,
        input: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt }
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
      if (useSearch) body.tools = [{ type: 'web_search_preview' }];

      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${requireEnv('OPENAI_API_KEY')}`
        },
        body: JSON.stringify(body)
      });

      const data = await response.json().catch(async () => ({ rawText: await response.text().catch(() => '') }));
      if (!response.ok) {
        throw new Error(`OpenAI Responses ${response.status}: ${JSON.stringify(data).slice(0, 1200)}`);
      }
      const text = parseOpenAIText(data);
      const parsed = normalizeStoryboardPayload(extractJsonObject(text), text);
      return { parsed, text, raw: data };
    }

    async function callChatCompletionsWithSchema() {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${requireEnv('OPENAI_API_KEY')}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'storyboard_response',
              strict: true,
              schema
            }
          }
        })
      });
      const data = await response.json().catch(async () => ({ rawText: await response.text().catch(() => '') }));
      if (!response.ok) {
        throw new Error(`OpenAI Chat ${response.status}: ${JSON.stringify(data).slice(0, 1200)}`);
      }
      const text = data.choices?.[0]?.message?.content || '';
      const parsed = normalizeStoryboardPayload(extractJsonObject(text), text);
      return { parsed, text, raw: data };
    }

    function localFallbackStoryboard(ideaText) {
      const target = /(?:^|\D)(\d{2,3})\s*(?:sec|seconds|сек|секунд)/i.exec(ideaText);
      const total = target ? Math.max(15, Math.min(90, Number(target[1]))) : 30;
      const durations = total <= 25 ? [2, 4, 5, 5, 4, 3] : [2, 4, 5, 6, 5, 4, 4];
      const sum = durations.reduce((a, b) => a + b, 0);
      const scale = total / sum;
      const finalDurations = durations.map((d) => Math.max(2, Math.round(d * scale)));
      const base = String(ideaText).replace(/\s+/g, ' ').trim();
      const beats = [
        ['I used to think this was the smart move.', 'A close, direct-to-camera hook with a slightly concerned expression.'],
        ['But the problem is, most people skip the boring step that actually protects them.', 'The creator gestures toward a notebook and laptop on a kitchen counter.'],
        ['Before I invest money, I want a small emergency fund sitting there first.', 'Close-up of hands writing a simple money plan in a notebook.'],
        ['Because one surprise bill can force you to sell at the worst possible time.', 'The creator points at a simple downward chart on a laptop screen.'],
        ['So my rule is simple: protect the basics, then build long term.', 'Medium shot, calm explanation, clean home workspace.'],
        ['If you want, start tiny. Even one week of expenses is better than zero.', 'Close-up of phone calculator and notebook checklist.'],
        ['That is how investing stops feeling like gambling.', 'Final direct-to-camera shot with a clear, grounded CTA energy.']
      ];
      const scenes = finalDurations.map((duration, i) => {
        const [narration, visual] = beats[i] || beats[beats.length - 1];
        return normalizeSceneObject({
          scene: i + 1,
          duration,
          narration,
          visual,
          imagePrompt: `Photorealistic vertical UGC frame. ${visual} Based on the user's topic: ${base}. Modern realistic home interior, natural daylight, casual outfit, iPhone-style composition, shallow depth of field, non-glossy authentic social media look.`,
          videoPrompt: `Subtle handheld camera movement. The creator performs the action naturally: ${visual}. Realistic motion, no dramatic effects, UGC style.`,
          onScreenText: i === 0 ? 'Don’t skip this step' : ''
        }, i);
      });
      return {
        title: 'UGC financial explainer',
        totalDuration: scenes.reduce((sum, s) => sum + s.duration, 0),
        script: scenes.map((s) => s.narration).join(' '),
        scenes
      };
    }

    const attempts = [];
    let parsed = null;
    let text = '';

    for (const attempt of [
      ['responses_web_search', () => callResponsesWithSchema(true)],
      ['responses_no_search', () => callResponsesWithSchema(false)],
      ['chat_completions_schema', () => callChatCompletionsWithSchema()]
    ]) {
      const [name, fn] = attempt;
      try {
        const result = await fn();
        attempts.push({ name, ok: Boolean(result.parsed), textPreview: String(result.text || '').slice(0, 300) });
        if (result.parsed) {
          parsed = result.parsed;
          text = result.text;
          break;
        }
      } catch (err) {
        attempts.push({ name, ok: false, error: err.message });
        console.warn(`Storyboard attempt failed: ${name}`, err.message);
      }
    }

    if (!parsed) {
      console.warn('OpenAI did not return scenes. Using local fallback storyboard.', JSON.stringify(attempts).slice(0, 2500));
      parsed = localFallbackStoryboard(idea);
      text = JSON.stringify(parsed, null, 2);
    }

    res.json({
      ok: true,
      version: 'v7-chats-autosave',
      creator: CREATORS[selectedCreatorSlug],
      title: parsed.title,
      totalDuration: parsed.totalDuration,
      script: parsed.script,
      scenes: parsed.scenes,
      text: JSON.stringify(parsed, null, 2),
      parsed,
      debugAttempts: attempts
    });
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
      outputResolution = '1K',
      creatorSlug = 'michael'
    } = req.body;

    const selectedCreatorSlug = normalizeCreatorSlug(creatorSlug);

    if (!prompt) return res.status(400).json({ ok: false, error: 'Prompt is required' });

    const referenceUrls = [];
    for (const img of referenceImages) {
      referenceUrls.push(await ensurePublicImageUrl(img, creatorFolder(selectedCreatorSlug, 'references')));
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
      const uploaded = await uploadBufferToSupabase(result.buffer, result.contentType || 'image/png', creatorFolder(selectedCreatorSlug, 'generated-images'));
      return res.json({ ok: true, url: uploaded.url, path: uploaded.path, referenceUrls, creator: CREATORS[selectedCreatorSlug] });
    }

    const url = extractUrlFromJson(result.data);
    if (url) return res.json({ ok: true, url, raw: result.data, referenceUrls, creator: CREATORS[selectedCreatorSlug] });

    const b64 = extractBase64FromJson(result.data);
    if (b64) {
      const buffer = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      const uploaded = await uploadBufferToSupabase(buffer, 'image/png', creatorFolder(selectedCreatorSlug, 'generated-images'));
      return res.json({ ok: true, url: uploaded.url, path: uploaded.path, raw: result.data, referenceUrls, creator: CREATORS[selectedCreatorSlug] });
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
      generateAudio = true,
      creatorSlug = 'michael'
    } = req.body;

    const selectedCreatorSlug = normalizeCreatorSlug(creatorSlug);

    if (!prompt) return res.status(400).json({ ok: false, error: 'Prompt is required' });
    if (!image) return res.status(400).json({ ok: false, error: 'Image URL or data URL is required' });

    const imageUrl = await ensurePublicImageUrl(image, creatorFolder(selectedCreatorSlug, 'video-inputs'));
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
      const uploaded = await uploadBufferToSupabase(result.buffer, result.contentType || 'video/mp4', creatorFolder(selectedCreatorSlug, 'generated-videos'));
      return res.json({ ok: true, url: uploaded.url, path: uploaded.path, imageUrl, creator: CREATORS[selectedCreatorSlug] });
    }

    const url = extractUrlFromJson(result.data);
    if (url) return res.json({ ok: true, url, raw: result.data, imageUrl, creator: CREATORS[selectedCreatorSlug] });

    const b64 = extractBase64FromJson(result.data);
    if (b64) {
      const buffer = Buffer.from(b64.replace(/^data:video\/\w+;base64,/, ''), 'base64');
      const uploaded = await uploadBufferToSupabase(buffer, 'video/mp4', creatorFolder(selectedCreatorSlug, 'generated-videos'));
      return res.json({ ok: true, url: uploaded.url, path: uploaded.path, raw: result.data, imageUrl, creator: CREATORS[selectedCreatorSlug] });
    }

    if (result.data?.id || result.data?.job_id) {
      return res.json({ ok: true, jobId: result.data.id || result.data.job_id, raw: result.data, imageUrl, creator: CREATORS[selectedCreatorSlug] });
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
