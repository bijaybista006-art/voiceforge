# Supabase setup and the move off Vercel storage

VoiceForge keeps everything in one Supabase project: voice clips and generated
audio in a storage bucket, and settings, API keys, jobs and the backend
registry in Postgres. Vercel hosts the frontend only.

Nothing on Vercel is deleted by any step here until the very last one, and
that one you do by hand.

## 1. Create the project

1. <https://supabase.com> → **New project**. Any name; pick the region closest
   to you. Save the database password somewhere — the app does not use it.
2. Wait for it to finish provisioning.

## 2. Create the bucket, tables and functions

1. In the project: **SQL Editor** → **New query**.
2. Paste the whole of `supabase/migrations/0001_voiceforge_storage.sql` → **Run**.
3. Expect "Success. No rows returned". It is safe to run twice.

That creates the public bucket `voiceforge-audio`, the tables `kv`,
`audio_files` and `rate_limits`, and the functions the app calls.

## 3. Put the keys in `.env.local`

**Project Settings → API** (or **API Keys**) has all three values.

Copy `.env.example` to `.env.local` and fill in:

```
NEXT_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon / publishable key>
SUPABASE_SERVICE_ROLE_KEY=<service_role / secret key>
```

The service-role key is a secret. It goes in `.env.local` and in Vercel's
environment variables, nowhere else — not in chat, not in a notebook, not in
Modal. `.env.local` is already ignored by git.

For the one-time move, also add the old stores' values to `.env.local`.
Find them in Vercel → `bbox-audio` → **Settings → Environment Variables**
(or each store's `.env.local` tab under **Storage**):

```
BLOB_READ_WRITE_TOKEN=...
UPSTASH_REDIS_REST_URL=...        # shown by Vercel as KV_REST_API_URL
UPSTASH_REDIS_REST_TOKEN=...      # shown by Vercel as KV_REST_API_TOKEN
```

## 4. Prove the project is set up correctly

```bash
node --env-file=.env.local scripts/check-supabase.ts
```

It stores, reads, locks, counts, rate-limits, uploads, signs an upload and
deletes — once each, against your real project — and confirms the anon key
can do none of it. Every line should say `ok`. It cleans up after itself.

## 5. Copy the data across

See what would happen first:

```bash
node --env-file=.env.local scripts/migrate-to-supabase.ts --dry-run
```

Then do it:

```bash
node --env-file=.env.local scripts/migrate-to-supabase.ts
```

- It only reads from Vercel. Running it again skips whatever is already across.
- Audio older than your retention setting (7 days by default) and files whose
  job no longer exists are **not** copied: the daily sweep would delete them
  anyway, and Supabase's free plan holds 1 GB. Add `--all` to copy everything.
- Links stored inside records are rewritten to the new bucket.
- It ends with source / copied / skipped / failed counts and fetches five of
  the copied files by their new URL.

**If Vercel refuses because the team is paused**, export by hand and import
the copies:

- Files: Vercel → **Storage** → `voiceforge-blob` → **Browse** → download,
  keeping the folders (`voices/`, `jobs/`, `assets/`, …) as they are.
- Data: Upstash console → your database → **Data Browser / Backup → Export**
  as JSON.

```bash
node --env-file=.env.local scripts/migrate-to-supabase.ts --from-dir ./blob-export --kv-json ./upstash.json --old-base https://<store-id>.public.blob.vercel-storage.com
```

`--old-base` is the address the old files were served from; it is the first
part of any old audio link.

## 6. Run the app against Supabase

```bash
npm run dev
```

Check, in this order: the admin dashboard shows Supabase connected → Voices
lists your voices and a clip plays → generate a short clip → it appears under
Jobs and plays → delete it.

## 7. Go live

In Vercel → `bbox-audio` → **Settings → Environment Variables**, add the same
three `SUPABASE` values for Production (and Preview), then merge the
`supabase-storage` branch and redeploy.

## 8. n8n

Workflows that upload files (`POST /api/v1/uploads`) keep working **if** they
use the `upload_url` and `headers` from the response as given. The headers
are different now (`content-type` and `x-upsert`; there is no `authorization`
header any more), so a workflow that hardcodes the old header names needs
that node updated.

## 9. Remove the old stores — only once everything above is verified

Deleting a store is permanent.

1. Vercel → `bbox-audio` → **Storage** tab.
2. `voiceforge-blob` → **Settings** → **Disconnect** from `bbox-audio`
   (under "Projects") → then **Delete Store** → type the name to confirm.
3. `upstash-kv-cerise-candle` → **Settings** → **Disconnect** from
   `bbox-audio` → then **Delete Database** (it may send you to the Upstash
   console to finish).
4. **Settings → Environment Variables**: remove anything left over that
   starts with `BLOB_`, `KV_` or `UPSTASH_`.
5. Redeploy.

## Limits to know (free plan)

| Limit | What it means here |
|---|---|
| 1 GB of files | The daily cleanup keeps generated audio to your retention window. |
| 50 MB per file | Same ceiling the app already had for assets and recordings. |
| Pauses after 7 days of no activity | The daily cleanup cron counts as activity. If it does pause, un-pause it from the dashboard; no data is lost. |
