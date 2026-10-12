-- VoiceForge storage on Supabase.
--
-- Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Safe to run again: every statement is "if not exists" or "create or replace".
--
-- Everything here is reached with the service-role key, from the server only.
-- Row level security is ON with no policies, so the anon key can read nothing
-- and write nothing. Files are read by plain public URL, which needs no policy.

-- ---------------------------------------------------------------- the bucket
--
-- Public, because the GPU backends, n8n and the render step all fetch files
-- by plain URL and a job's audio_url has to keep working for as long as the
-- file exists. Paths carry random ids. 50 MB is the largest file the free
-- plan stores.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'voiceforge-audio', 'voiceforge-audio', true, 52428800,
  array['audio/*', 'video/*', 'image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------- the file ledger
--
-- One row per stored file. Lists are read from here, never by listing the
-- bucket.
create table if not exists public.audio_files (
  id           uuid primary key default gen_random_uuid(),
  path         text not null unique,
  public_url   text not null,
  -- voice | job | presenter-clip | presenter | asset | upload | other
  kind         text not null default 'other',
  content_type text,
  size_bytes   bigint,
  duration     real,
  voice        text,
  text         text,
  language     text,
  job_id       text,
  created_at   timestamptz not null default now()
);
create index if not exists audio_files_created_idx on public.audio_files (created_at desc);
create index if not exists audio_files_kind_idx on public.audio_files (kind, created_at desc);
alter table public.audio_files enable row level security;

-- ------------------------------------------------------------ the key store
--
-- Replaces Upstash. Every key the app used keeps its name:
--
--   vf:settings                                     platform settings
--   vf:voice:<id>, vf:voices, vf:voice:default      voice library
--   vf:apikey:<id>, vf:apikey:h:<hash>, vf:apikeys  API keys
--   vf:usage:<id>:<yyyy-mm>                         monthly character count
--   vf:job:<id>, vf:jobs                            jobs
--   job:<id>:collecting                             collection lock (expires)
--   vf:backend:<provider>, vf:backend:active        GPU backends + heartbeat
--   vf:presenter:<id>, vf:presenters, vf:presenter:default
--   vf:asset:<id>, vf:assets
--   vf:upload:<id>, vf:uploads
--   vf:login:<ip>                                   login throttle (expires)
create table if not exists public.kv (
  key        text primary key,
  value      jsonb not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists kv_expires_idx on public.kv (expires_at) where expires_at is not null;
alter table public.kv enable row level security;

create table if not exists public.rate_limits (
  key          text not null,
  window_start bigint not null,
  hits         integer not null default 0,
  touched_at   timestamptz not null default now(),
  primary key (key, window_start)
);
alter table public.rate_limits enable row level security;

-- An expired row is the same as no row, everywhere below.

create or replace function public.kv_get(p_keys text[])
returns table (key text, value jsonb)
language sql stable
set search_path = public
as $$
  select k.key, k.value from public.kv k
  where k.key = any(p_keys) and (k.expires_at is null or k.expires_at > now());
$$;

create or replace function public.kv_set(p_key text, p_value jsonb, p_ttl integer default null)
returns void
language sql
set search_path = public
as $$
  insert into public.kv (key, value, expires_at, updated_at)
  values (p_key, p_value,
          case when p_ttl > 0 then now() + make_interval(secs => p_ttl) end, now())
  on conflict (key) do update
    set value = excluded.value, expires_at = excluded.expires_at, updated_at = now();
$$;

-- Set only if absent: true when this caller now holds the key. One statement,
-- so two callers can never both win.
create or replace function public.kv_set_nx(p_key text, p_value jsonb, p_ttl integer default null)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  won boolean;
begin
  insert into public.kv as k (key, value, expires_at, updated_at)
  values (p_key, p_value,
          case when p_ttl > 0 then now() + make_interval(secs => p_ttl) end, now())
  on conflict (key) do update
    set value = excluded.value, expires_at = excluded.expires_at, updated_at = now()
    where k.expires_at is not null and k.expires_at <= now()
  returning true into won;
  return coalesce(won, false);
end;
$$;

create or replace function public.kv_del(p_key text)
returns void
language sql
set search_path = public
as $$
  delete from public.kv where key = p_key;
$$;

-- Add to a counter and return the new total. Starts from zero when the key
-- is absent or expired; an existing expiry is kept.
create or replace function public.kv_incr(p_key text, p_by bigint default 1)
returns bigint
language plpgsql
set search_path = public
as $$
declare
  total bigint;
begin
  insert into public.kv as k (key, value, updated_at)
  values (p_key, to_jsonb(p_by), now())
  on conflict (key) do update
    set value = case
          when k.expires_at is not null and k.expires_at <= now() then to_jsonb(p_by)
          else to_jsonb(coalesce((k.value #>> '{}')::bigint, 0) + p_by)
        end,
        expires_at = case
          when k.expires_at is not null and k.expires_at <= now() then null
          else k.expires_at
        end,
        updated_at = now()
  returning (k.value #>> '{}')::bigint into total;
  return total;
end;
$$;

create or replace function public.kv_expire(p_key text, p_ttl integer)
returns void
language sql
set search_path = public
as $$
  update public.kv set expires_at = now() + make_interval(secs => p_ttl) where key = p_key;
$$;

-- Sliding window over two fixed windows: the previous one counts in
-- proportion to how much of it still overlaps the last p_window seconds.
create or replace function public.rate_limit(p_key text, p_limit integer, p_window integer)
returns table (allowed boolean, reset_at timestamptz)
language plpgsql
set search_path = public
as $$
declare
  now_s     double precision := extract(epoch from clock_timestamp());
  cur       bigint := floor(now_s / p_window);
  prev_hits integer;
  cur_hits  integer;
begin
  select r.hits into prev_hits from public.rate_limits r
   where r.key = p_key and r.window_start = cur - 1;

  insert into public.rate_limits as r (key, window_start, hits, touched_at)
  values (p_key, cur, 1, now())
  on conflict (key, window_start) do update set hits = r.hits + 1, touched_at = now()
  returning r.hits into cur_hits;

  delete from public.rate_limits r where r.key = p_key and r.window_start < cur - 1;

  allowed := coalesce(prev_hits, 0) * (1 - (now_s - cur * p_window) / p_window) + cur_hits <= p_limit;
  reset_at := to_timestamp((cur + 1) * p_window);
  return next;
end;
$$;

-- Called by the daily sweep.
create or replace function public.kv_purge_expired()
returns integer
language plpgsql
set search_path = public
as $$
declare
  gone integer;
begin
  delete from public.kv where expires_at is not null and expires_at <= now();
  get diagnostics gone = row_count;
  delete from public.rate_limits where touched_at < now() - interval '3 hours';
  return gone;
end;
$$;

-- Supabase lets the anon and signed-in roles call any function in "public"
-- unless told otherwise. These are for the server alone.
revoke all on function
  public.kv_get(text[]), public.kv_set(text, jsonb, integer),
  public.kv_set_nx(text, jsonb, integer), public.kv_del(text),
  public.kv_incr(text, bigint), public.kv_expire(text, integer),
  public.rate_limit(text, integer, integer), public.kv_purge_expired()
from public, anon, authenticated;

grant execute on function
  public.kv_get(text[]), public.kv_set(text, jsonb, integer),
  public.kv_set_nx(text, jsonb, integer), public.kv_del(text),
  public.kv_incr(text, bigint), public.kv_expire(text, integer),
  public.rate_limit(text, integer, integer), public.kv_purge_expired()
to service_role;

revoke all on public.kv, public.rate_limits, public.audio_files from anon, authenticated;
