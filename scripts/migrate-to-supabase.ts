/**
 * One-time move of VoiceForge's data from Vercel Blob + Upstash to Supabase.
 *
 *   node --env-file=.env.local scripts/migrate-to-supabase.ts --dry-run
 *   node --env-file=.env.local scripts/migrate-to-supabase.ts
 *
 * Reads only from the old stores; nothing there is changed or deleted.
 * Safe to run again: a file or key that is already in Supabase is skipped.
 *
 * Needs in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY      (destination)
 *   BLOB_READ_WRITE_TOKEN                                    (old files)
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN         (old data)
 *
 * If Vercel refuses the old stores because the team is paused, export by
 * hand and point the script at the copies instead:
 *   --from-dir <folder>   files, laid out by their paths (voices/…, jobs/…)
 *   --kv-json <file>      a JSON object of { "key": value } (or an array of
 *                         { key, value, ttl })
 *   --old-base <url>      the old store's address, e.g.
 *                         https://abc123.public.blob.vercel-storage.com
 *
 * Other flags:
 *   --dry-run       report what would happen, write nothing
 *   --all           also copy audio that the retention sweep would delete
 *   --overwrite-kv  replace keys that already exist in Supabase
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "voiceforge-audio";
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// Rebuilt by use, or meaningless outside the store they came from.
const EPHEMERAL = [/^vf:rl/, /^vf:login:/, /:collecting$/, /^vf:blob:base$/, /^@upstash\//];

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const DRY = flag("dry-run");
const ALL = flag("all");
const OVERWRITE_KV = flag("overwrite-kv");
const FROM_DIR = option("from-dir");
const KV_JSON = option("kv-json");

function need(name: string, ...alternatives: string[]): string {
  for (const n of [name, ...alternatives]) if (process.env[n]) return process.env[n] as string;
  console.error(`Missing ${name} in the environment (.env.local).`);
  process.exit(1);
}

const SUPABASE_URL = need("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL").replace(/\/+$/, "");
const db = createClient(SUPABASE_URL, need("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const NEW_BASE = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}`;

interface KvEntry {
  key: string;
  value: unknown;
  /** Seconds left, or null for a key that never expires. */
  ttl: number | null;
}
interface SourceFile {
  path: string;
  size: number;
  createdAt: Date;
  read: () => Promise<{ bytes: ArrayBuffer; contentType?: string }>;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// --------------------------------------------------------------- old data

async function kvFromUpstash(): Promise<KvEntry[]> {
  const { Redis } = await import("@upstash/redis");
  const redis = new Redis({
    url: need("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"),
    token: need("UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN"),
  });
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, { count: 500 });
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== "0");

  const entries: KvEntry[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const slice = keys.slice(i, i + 100).filter((k) => !EPHEMERAL.some((re) => re.test(k)));
    if (!slice.length) continue;
    const pipe = redis.pipeline();
    for (const k of slice) {
      pipe.type(k);
      pipe.ttl(k);
    }
    const meta = await pipe.exec<(string | number)[]>();
    // Only plain values are ours; anything else belongs to a library.
    const plain = slice.filter((_k, n) => meta[n * 2] === "string");
    if (!plain.length) continue;
    const values = await redis.mget<unknown[]>(...plain);
    plain.forEach((k, n) => {
      const ttl = Number(meta[slice.indexOf(k) * 2 + 1]);
      if (values[n] !== null && values[n] !== undefined) {
        entries.push({ key: k, value: values[n], ttl: ttl > 0 ? ttl : null });
      }
    });
  }
  return entries;
}

async function kvFromJson(file: string): Promise<KvEntry[]> {
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  const parse = (v: unknown) => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  const rows: KvEntry[] = Array.isArray(raw)
    ? (raw as { key: string; value: unknown; ttl?: number }[]).map((r) => ({
        key: r.key,
        value: parse(r.value),
        ttl: r.ttl && r.ttl > 0 ? r.ttl : null,
      }))
    : Object.entries(raw as Record<string, unknown>).map(([key, value]) => ({
        key,
        value: parse(value),
        ttl: null,
      }));
  return rows.filter((r) => !EPHEMERAL.some((re) => re.test(r.key)));
}

// -------------------------------------------------------------- old files

async function filesFromBlob(): Promise<{ files: SourceFile[]; oldBase: string | null }> {
  const { list } = await import("@vercel/blob");
  const token =
    process.env.BLOB_READ_WRITE_TOKEN ??
    process.env[Object.keys(process.env).find((k) => k.endsWith("BLOB_READ_WRITE_TOKEN")) ?? ""];
  if (!token) need("BLOB_READ_WRITE_TOKEN");
  const files: SourceFile[] = [];
  let oldBase: string | null = null;
  let cursor: string | undefined;
  do {
    const page = await list({ token, cursor, limit: 1000 });
    for (const b of page.blobs) {
      oldBase ??= new URL(b.url).origin;
      files.push({
        path: b.pathname,
        size: b.size,
        createdAt: new Date(b.uploadedAt),
        read: async () => {
          const res = await fetch(b.url);
          if (!res.ok) throw new Error(`download returned ${res.status}`);
          return {
            bytes: await res.arrayBuffer(),
            contentType: res.headers.get("content-type") ?? undefined,
          };
        },
      });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return { files, oldBase };
}

const TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

async function filesFromDir(root: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const info = await stat(full);
      files.push({
        path: path.relative(root, full).split(path.sep).join("/"),
        size: info.size,
        createdAt: info.mtime,
        read: async () => {
          const buf = await readFile(full);
          return {
            bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
            contentType: TYPES[path.extname(full).toLowerCase()],
          };
        },
      });
    }
  }
  await walk(root);
  return files;
}

function kindOf(p: string): string {
  if (p.startsWith("voices/")) return "voice";
  if (p.startsWith("jobs/")) return "job";
  if (p.startsWith("presenter-clips/")) return "presenter-clip";
  if (p.startsWith("presenters/")) return "presenter";
  if (p.startsWith("assets/")) return "asset";
  if (p.startsWith("uploads/")) return "upload";
  return "other";
}

/** The job a generated file belongs to: jobs/<id>.mp3, jobs/<id>-3.mp3, presenter-clips/<id>.mp4 */
function jobIdOf(p: string): string | null {
  const m = /^(?:jobs|presenter-clips)\/([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(p);
  return m ? m[1] : null;
}

// ------------------------------------------------------------------- main

async function main(): Promise<void> {
  console.log(DRY ? "DRY RUN — nothing will be written.\n" : "");

  // 1. the old data ---------------------------------------------------------
  let kv: KvEntry[];
  try {
    kv = KV_JSON ? await kvFromJson(KV_JSON) : await kvFromUpstash();
  } catch (e) {
    console.error(
      "\nCould not read the old key store:",
      e instanceof Error ? e.message : e,
      "\nIf the team is paused, export the database from the Upstash console as JSON" +
        "\nand run again with --kv-json <file>."
    );
    process.exit(1);
  }
  const byKey = new Map(kv.map((e) => [e.key, e]));
  console.log(`Old key store: ${kv.length} keys`);

  // 2. what the retention sweep would have deleted anyway --------------------
  const settings = (byKey.get("vf:settings")?.value ?? {}) as { retentionDays?: number };
  const retentionDays = settings.retentionDays ?? 7;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const liveJobs = new Set<string>();
  const expiredKeys = new Set<string>();
  const expiredUploadPaths = new Set<string>();
  for (const e of kv) {
    if (e.key.startsWith("vf:job:")) {
      const job = e.value as { id?: string; createdAt?: number };
      const id = job.id ?? e.key.slice("vf:job:".length);
      if (!ALL && (job.createdAt ?? 0) < cutoff) expiredKeys.add(e.key);
      else liveJobs.add(id);
    }
    if (e.key.startsWith("vf:upload:")) {
      const up = e.value as { pathname?: string; expiresAt?: number | null };
      if (!ALL && up.expiresAt != null && up.expiresAt < Date.now()) {
        expiredKeys.add(e.key);
        if (up.pathname) expiredUploadPaths.add(up.pathname);
      }
    }
  }
  // Take the swept rows out of their indexes too.
  for (const [indexKey, prefix] of [
    ["vf:jobs", "vf:job:"],
    ["vf:uploads", "vf:upload:"],
  ] as const) {
    const index = byKey.get(indexKey);
    if (index && Array.isArray(index.value)) {
      index.value = (index.value as string[]).filter((id) => !expiredKeys.has(prefix + id));
    }
  }
  if (!ALL) {
    console.log(
      `Retention is ${retentionDays} days: ${expiredKeys.size} expired job/upload records will not be copied (use --all to keep them).`
    );
  }

  // 3. the old files ---------------------------------------------------------
  let files: SourceFile[];
  let oldBase = option("old-base")?.replace(/\/+$/, "") ?? null;
  try {
    if (FROM_DIR) files = await filesFromDir(FROM_DIR);
    else {
      const listed = await filesFromBlob();
      files = listed.files;
      oldBase ??= listed.oldBase;
    }
  } catch (e) {
    console.error(
      "\nCould not list the old file store:",
      e instanceof Error ? e.message : e,
      "\nIf the team is paused, download the files from Vercel -> Storage -> voiceforge-blob" +
        "\n-> Browse, keep their folder layout, and run again with --from-dir <folder>."
    );
    process.exit(1);
  }
  const sourceBytes = files.reduce((n, f) => n + f.size, 0);
  console.log(`Old file store: ${files.length} files, ${mb(sourceBytes)}`);
  if (!oldBase) {
    console.warn(
      "The old store's address is unknown, so links inside records cannot be rewritten. Pass --old-base <url>."
    );
  }

  // Already there?
  const have = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("audio_files").select("path").range(from, from + 999);
    if (error) {
      console.error(
        `\nCould not read audio_files: ${error.message}\nHas supabase/migrations/0001_voiceforge_storage.sql been run?`
      );
      process.exit(1);
    }
    for (const r of data ?? []) have.add(r.path as string);
    if (!data || data.length < 1000) break;
  }

  // Every link held by a record that is being kept, as one searchable text.
  const referenced = JSON.stringify(
    kv.filter((e) => !expiredKeys.has(e.key)).map((e) => e.value)
  ).replace(/"pathname":"/g, '"pathname":"/');

  const tally = { copied: 0, copiedBytes: 0, existing: 0, swept: 0, sweptBytes: 0, failed: 0 };
  const failures: string[] = [];
  const copiedPaths: string[] = [];
  /** What is being kept, by top folder: [files, bytes]. */
  const kept = new Map<string, [number, number]>();

  for (const [n, f] of files.entries()) {
    const jobId = jobIdOf(f.path);
    // A generated file whose job is gone or expired is what the sweep exists
    // to remove; so is an expired scene upload.
    // Copy what the app can still reach. A file no record points at cannot
    // be listed, played or swept by anything; in Supabase it would only be
    // dead weight against a 1 GB limit, for ever.
    const swept =
      !ALL &&
      ((jobId !== null && !liveJobs.has(jobId)) ||
        expiredUploadPaths.has(f.path) ||
        !referenced.includes(`/${f.path}"`));
    if (swept) {
      tally.swept++;
      tally.sweptBytes += f.size;
      continue;
    }
    const folder = f.path.split("/").slice(0, f.path.startsWith("assets/") ? 2 : 1).join("/");
    const sum = kept.get(folder) ?? [0, 0];
    kept.set(folder, [sum[0] + 1, sum[1] + f.size]);
    if (have.has(f.path)) {
      tally.existing++;
      continue;
    }
    if (f.size > MAX_FILE_BYTES) {
      tally.failed++;
      failures.push(`${f.path}: ${mb(f.size)} is over the 50 MB a free Supabase bucket stores`);
      continue;
    }
    if (DRY) {
      tally.copied++;
      tally.copiedBytes += f.size;
      continue;
    }
    try {
      const { bytes, contentType } = await f.read();
      const { error } = await db.storage
        .from(BUCKET)
        .upload(f.path, bytes, { contentType, upsert: true });
      if (error) throw new Error(error.message);

      const row: Record<string, unknown> = {
        path: f.path,
        public_url: `${NEW_BASE}/${f.path}`,
        kind: kindOf(f.path),
        content_type: contentType ?? null,
        size_bytes: bytes.byteLength,
        created_at: f.createdAt.toISOString(),
      };
      if (jobId) {
        row.job_id = jobId;
        const job = byKey.get(`vf:job:${jobId}`)?.value as
          | { duration?: number; voiceId?: string }
          | undefined;
        row.duration = job?.duration ?? null;
        row.voice = job?.voiceId ?? null;
      }
      const voiceId = /^voices\/(.+)\.wav$/.exec(f.path)?.[1];
      if (voiceId) {
        const v = byKey.get(`vf:voice:${voiceId}`)?.value as
          | { language?: string; durationSec?: number; transcript?: string }
          | undefined;
        row.voice = voiceId;
        row.language = v?.language ?? null;
        row.duration = v?.durationSec ?? null;
        row.text = v?.transcript?.slice(0, 2000) ?? null;
      }
      const { error: rowError } = await db.from("audio_files").upsert(row, { onConflict: "path" });
      if (rowError) throw new Error(`stored, but not recorded: ${rowError.message}`);

      tally.copied++;
      tally.copiedBytes += bytes.byteLength;
      copiedPaths.push(f.path);
    } catch (e) {
      tally.failed++;
      failures.push(`${f.path}: ${e instanceof Error ? e.message : e}`);
    }
    if ((n + 1) % 25 === 0) console.log(`  …${n + 1} of ${files.length}`);
  }

  // 4. the data, with its links pointed at the new store ----------------------
  const rewrite = (value: unknown): unknown =>
    oldBase ? JSON.parse(JSON.stringify(value).split(oldBase).join(NEW_BASE)) : value;

  const rows = kv
    .filter((e) => !expiredKeys.has(e.key))
    .map((e) => ({
      key: e.key,
      value: rewrite(e.value),
      expires_at: e.ttl ? new Date(Date.now() + e.ttl * 1000).toISOString() : null,
    }));

  let kvWritten = 0;
  let kvFailed = 0;
  const { count: kvBefore } = await db.from("kv").select("key", { count: "exact", head: true });
  if (!DRY) {
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await db
        .from("kv")
        .upsert(rows.slice(i, i + 200), { onConflict: "key", ignoreDuplicates: !OVERWRITE_KV });
      if (error) {
        kvFailed += Math.min(200, rows.length - i);
        failures.push(`kv batch at ${i}: ${error.message}`);
      } else kvWritten += Math.min(200, rows.length - i);
    }
  }
  const { count: kvAfter } = await db.from("kv").select("key", { count: "exact", head: true });

  // 5. the account ------------------------------------------------------------
  const expected = files.length - tally.swept;
  const { count: ledger } = await db
    .from("audio_files")
    .select("path", { count: "exact", head: true });

  console.log("\n================ FILES ================");
  console.log(`source                 ${files.length}  (${mb(sourceBytes)})`);
  console.log(`not copied (unreachable) ${tally.swept}  (${mb(tally.sweptBytes)})`);
  console.log(`already in Supabase    ${tally.existing}`);
  console.log(`${DRY ? "would copy" : "copied now"}             ${tally.copied}  (${mb(tally.copiedBytes)})`);
  console.log(`failed                 ${tally.failed}`);
  console.log(`expected in Supabase   ${expected}`);
  console.log(`rows in audio_files    ${ledger ?? "?"}`);

  console.log("\nkept, by folder:");
  for (const [folder, [n, bytes]] of [...kept].sort((a, b) => b[1][1] - a[1][1])) {
    console.log(`  ${folder.padEnd(22)} ${String(n).padStart(5)}  ${mb(bytes)}`);
  }

  console.log("\n================ KEYS =================");
  console.log(`source                 ${kv.length}`);
  console.log(`not copied (expired)   ${expiredKeys.size}`);
  console.log(`to copy                ${rows.length}`);
  console.log(`sent                   ${kvWritten}  (existing keys are ${OVERWRITE_KV ? "replaced" : "left alone"})`);
  console.log(`failed                 ${kvFailed}`);
  console.log(`rows in kv             before ${kvBefore ?? "?"}, after ${kvAfter ?? "?"}`);

  if (failures.length) {
    console.log("\n================ FAILED ===============");
    for (const f of failures) console.log(" - " + f);
  }

  // Five of the files just copied, fetched the way a backend would.
  if (copiedPaths.length) {
    console.log("\n================ SPOT CHECK ===========");
    const sample = [...copiedPaths].sort(() => Math.random() - 0.5).slice(0, 5);
    for (const p of sample) {
      const res = await fetch(`${NEW_BASE}/${p}`, { method: "HEAD" }).catch(() => null);
      console.log(` ${res?.ok ? "ok  " : "FAIL"} ${res?.status ?? "-"}  ${NEW_BASE}/${p}`);
    }
  }

  const clean = tally.failed === 0 && kvFailed === 0 && (DRY || (ledger ?? 0) >= expected);
  console.log(
    clean
      ? DRY
        ? "\nDry run finished. Run again without --dry-run to copy."
        : "\nEverything expected is in Supabase."
      : "\nNot complete — see FAILED above, fix, and run again (finished items are skipped)."
  );
  process.exit(clean ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
