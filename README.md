[README.md](https://github.com/user-attachments/files/28260798/README.md)
# Content Factory Backend v7

Backend for AI content factory.

## Features
- OpenAI storyboard generation
- Segmind image/video generation
- Supabase Storage for assets
- Fixed creators: Michael, Sara, Rob, Emily
- Chats autosave in Supabase table `chats`

## Render settings

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

Required environment variables:

```env
OPENAI_API_KEY=...
SEGMIND_API_KEY=...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_BUCKET=content-assets
```
