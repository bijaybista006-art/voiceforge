/**
 * Proves a Supabase project is set up the way VoiceForge needs, by doing
 * each thing the app does once against the real project.
 *
 *   node --env-file=.env.local scripts/check-supabase.ts
 *
 * Everything it writes is under a "vf:selfcheck" key or a "selfcheck/" path
 * and is removed again. Exits non-zero if any check fails.
 */

import { createClient } from "@supabase/supabase-js";

const BUCKET = "voiceforge-audio";
const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
if (!url || !serviceKey) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local first.");
  process.exit(1);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
let failed = 0;

async function check(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const note = await fn();
    console.log(` ok    ${name}${note ? `  (${note})` : ""}`);
  } catch (e) {
    failed++;
    console.log(` FAIL  ${name}\n         ${e instanceof Error ? e.message : e}`);
  }
}

function same(got: unknown, want: unknown, what: string): void {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

const K = "vf:selfcheck";
const get = async (key: string) =>
  (await rpc<{ key: string; value: unknown }[]>("kv_get", { p_keys: [key] }))[0]?.value ?? null;

console.log(`Checking ${url}\n`);

// Every shape of value the app stores has to come back exactly as it went in.
for (const [label, value] of [
  ["an object", { id: "a", n: 1, list: ["x", "y"], nested: { ok: true } }],
  ["a list of ids", ["one", "two", "three"]],
  ["a plain string", "voice-id-123"],
  ["a number", 42],
] as const) {
  await check(`stores and returns ${label}`, async () => {
    await rpc("kv_set", { p_key: K, p_value: value, p_ttl: null });
    same(await get(K), value, "read back");
  });
}

await check("reads several keys in one call and skips missing ones", async () => {
  await rpc("kv_set", { p_key: `${K}:a`, p_value: 1, p_ttl: null });
  const rows = await rpc<{ key: string }[]>("kv_get", { p_keys: [`${K}:a`, `${K}:nope`] });
  same(rows.map((r) => r.key), [`${K}:a`], "keys returned");
  await rpc("kv_del", { p_key: `${K}:a` });
});

await check("an expired key reads as absent", async () => {
  await rpc("kv_set", { p_key: `${K}:ttl`, p_value: "soon", p_ttl: 1 });
  same(await get(`${K}:ttl`), "soon", "before expiry");
  await new Promise((r) => setTimeout(r, 1600));
  same(await get(`${K}:ttl`), null, "after expiry");
});

await check("a lock is won once, and again only after it expires", async () => {
  const key = `${K}:lock`;
  await rpc("kv_del", { p_key: key });
  same(await rpc("kv_set_nx", { p_key: key, p_value: "a", p_ttl: 1 }), true, "first claim");
  same(await rpc("kv_set_nx", { p_key: key, p_value: "b", p_ttl: 1 }), false, "second claim");
  await new Promise((r) => setTimeout(r, 1600));
  same(await rpc("kv_set_nx", { p_key: key, p_value: "c", p_ttl: 1 }), true, "claim after expiry");
  await rpc("kv_del", { p_key: key });
});

await check("ten simultaneous claims on one lock have exactly one winner", async () => {
  const key = `${K}:race`;
  await rpc("kv_del", { p_key: key });
  const results = await Promise.all(
    Array.from({ length: 10 }, (_v, i) => rpc<boolean>("kv_set_nx", { p_key: key, p_value: i, p_ttl: 30 }))
  );
  same(results.filter(Boolean).length, 1, "winners");
  await rpc("kv_del", { p_key: key });
});

await check("a counter counts, and twenty at once lose nothing", async () => {
  const key = `${K}:count`;
  await rpc("kv_del", { p_key: key });
  same(await rpc("kv_incr", { p_key: key, p_by: 1 }), 1, "first");
  same(await rpc("kv_incr", { p_key: key, p_by: 250 }), 251, "add 250");
  await Promise.all(Array.from({ length: 20 }, () => rpc("kv_incr", { p_key: key, p_by: 1 })));
  same(await get(key), 271, "after 20 at once");
  await rpc("kv_expire", { p_key: key, p_ttl: 1 });
  await new Promise((r) => setTimeout(r, 1600));
  same(await rpc("kv_incr", { p_key: key, p_by: 1 }), 1, "restarts after expiry");
  await rpc("kv_del", { p_key: key });
});

await check("the rate limit allows up to the limit and then refuses", async () => {
  const key = `${K}:rl:${Date.now()}`;
  const seen: boolean[] = [];
  for (let i = 0; i < 4; i++) {
    const rows = await rpc<{ allowed: boolean; reset_at: string }[]>("rate_limit", {
      p_key: key,
      p_limit: 3,
      p_window: 3600,
    });
    seen.push(rows[0].allowed);
    if (!Date.parse(rows[0].reset_at)) throw new Error("no reset time returned");
  }
  same(seen, [true, true, true, false], "allowed");
});

await check("the sweep runs", async () => `${await rpc<number>("kv_purge_expired", {})} expired keys removed`);

// --- files ---------------------------------------------------------------

const path = `selfcheck/${Date.now()}.wav`;
const publicUrl = `${url}/storage/v1/object/public/${BUCKET}/${path}`;
const bytes = new Uint8Array(2048).fill(7);

await check("the server can store a file, and store it again at the same path", async () => {
  for (let i = 0; i < 2; i++) {
    const { error } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: "audio/wav", upsert: true });
    if (error) throw new Error(error.message);
  }
});

await check("the file is readable by plain URL, as a backend would fetch it", async () => {
  const res = await fetch(publicUrl);
  if (!res.ok) throw new Error(`GET returned ${res.status} — is the bucket public?`);
  same((await res.arrayBuffer()).byteLength, bytes.length, "size");
});

await check("its size and type can be read back", async () => {
  const { data, error } = await db.storage.from(BUCKET).info(path);
  if (error || !data) throw new Error(error?.message ?? "no info");
  same(Number(data.size), bytes.length, "size");
  same(data.contentType, "audio/wav", "type");
});

await check("the ledger takes a row and lists it", async () => {
  const { error } = await db
    .from("audio_files")
    .upsert({ path, public_url: publicUrl, kind: "other", size_bytes: bytes.length }, { onConflict: "path" });
  if (error) throw new Error(error.message);
  const { data, count } = await db
    .from("audio_files")
    .select("*", { count: "exact" })
    .eq("path", path)
    .range(0, 0);
  same(data?.length, 1, "rows");
  return `${count} matching`;
});

const signedPath = `selfcheck/${Date.now()}-signed.png`;
await check("a signed URL accepts a plain PUT with no other credential, twice", async () => {
  const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(signedPath, { upsert: true });
  if (error || !data) throw new Error(error?.message ?? "no link");
  for (let i = 0; i < 2; i++) {
    const res = await fetch(data.signedUrl, {
      method: "PUT",
      headers: { "content-type": "image/png", "x-upsert": "true" },
      body: new Uint8Array(512).fill(i),
    });
    if (!res.ok) throw new Error(`PUT ${i + 1} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const { data: info } = await db.storage.from(BUCKET).info(signedPath);
  same(info?.contentType, "image/png", "stored type");
});

await check("the bucket refuses a type it does not hold", async () => {
  const { error } = await db.storage
    .from(BUCKET)
    .upload(`selfcheck/${Date.now()}.html`, "<p>no</p>", { contentType: "text/html", upsert: true });
  if (!error) throw new Error("an HTML file was accepted");
});

await check("files and their rows can be deleted", async () => {
  const { error } = await db.storage.from(BUCKET).remove([path, signedPath]);
  if (error) throw new Error(error.message);
  await db.from("audio_files").delete().eq("path", path);
  const res = await fetch(`${publicUrl}?t=${Date.now()}`);
  if (res.ok) return "deleted; the CDN may serve a cached copy for a short while";
});

// --- the anon key must be able to do nothing -------------------------------

if (anonKey) {
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  await check("the anon key cannot read the key store", async () => {
    const { data, error } = await anon.from("kv").select("key").limit(1);
    if (!error && (data?.length ?? 0) > 0) throw new Error("rows were returned to the anon key");
  });
  await check("the anon key cannot call the store's functions", async () => {
    const { error } = await anon.rpc("kv_get", { p_keys: ["vf:settings"] });
    if (!error) throw new Error("kv_get ran for the anon key");
  });
  await check("the anon key cannot write a file", async () => {
    const { error } = await anon.storage
      .from(BUCKET)
      .upload(`selfcheck/anon-${Date.now()}.wav`, bytes, { contentType: "audio/wav" });
    if (!error) throw new Error("the anon key stored a file");
  });
} else {
  console.log(" skip  anon-key checks (NEXT_PUBLIC_SUPABASE_ANON_KEY not set)");
}

await rpc("kv_del", { p_key: K }).catch(() => {});
await rpc("kv_del", { p_key: `${K}:ttl` }).catch(() => {});

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
