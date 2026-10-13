# Supabase setup

VoiceForge keeps everything in one Supabase project: voice clips and generated
audio in a storage bucket, and settings, API keys, jobs and the backend
registry in Postgres. Vercel hosts the frontend and nothing else.

## 1. Create the project

1. <https://supabase.com> → **New project**, free plan.
2. Region: **East US (North Virginia)** — that is where Vercel runs the app's
   functions, so reads stay fast.

## 2. Create the bucket, tables and functions

1. In the project: **SQL Editor** → **New query**.
2. Paste the whole of `supabase/migrations/0001_voiceforge_storage.sql` → **Run**.
3. Supabase warns that the query is "destructive" because it defines cleanup
   functions and removes anonymous access. On a new project, confirm.
4. Expect "Success. No rows returned". It is safe to run twice.

That creates the public bucket `voiceforge-audio`, the tables `kv`,
`audio_files` and `rate_limits`, and the functions the app calls.

## 3. Set the three variables

**Project Settings → API Keys** has the values.

```
NEXT_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon / publishable key>
SUPABASE_SERVICE_ROLE_KEY=<service_role / secret key>
```

Put them in Vercel → your project → **Settings → Environment Variables**
(Production and Preview), and in `.env.local` for local development.

The service-role key is a secret. It bypasses every access rule, so it
belongs only in those two places — not in a notebook, not in Modal, and never
under a name starting with `NEXT_PUBLIC_`.

## 4. Prove the project is set up correctly

```bash
node --env-file=.env.local scripts/check-supabase.ts
```

It stores, reads, locks, counts, rate-limits, uploads, signs an upload and
deletes — once each, against your real project — and confirms the anon key
can do none of it. Every line should say `ok`. It cleans up after itself.

## Limits to know (free plan)

| Limit | What it means here |
|---|---|
| 1 GB of files | The daily cleanup keeps generated audio and scene uploads to the retention window. |
| 50 MB per file | The same ceiling the app has for assets and recordings. |
| Pauses after 7 days of no activity | The daily cleanup cron counts as activity. If it does pause, un-pause it from the dashboard; no data is lost. |
