# Content Factory Backend

Backend for AI content factory.

## Render settings

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

Environment variables:

```env
OPENAI_API_KEY=...
SEGMIND_API_KEY=...
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_BUCKET=content-assets
```

## Test after deploy

Open:

```text
https://YOUR-RENDER-URL.onrender.com/api/health
```

Expected response:

```json
{"ok":true,"missing":[],"bucket":"content-assets","service":"content-factory-backend"}
```
