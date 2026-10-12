"use client";

import { uploadDirect } from "@/lib/directUpload";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import type { Asset, AssetKind } from "@/lib/types";
import { ASSET_KINDS } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import {
  IconAlert,
  IconImage,
  IconSparkle,
  IconTrash,
  IconUpload,
  IconVideo,
  IconWave,
} from "@/components/ui/Icons";

interface Payload {
  assets: Asset[];
  storageReady: boolean;
  hint: string | null;
  maxBytes: number;
}

/** What each kind is for, in the words you'd use when deciding what to upload. */
const KIND_HELP: Record<AssetKind, { label: string; blurb: string; accept: string }> = {
  music: {
    label: "Music",
    blurb: "Background tracks. One is picked at random and ducked under the voice.",
    accept: "audio/*",
  },
  sfx: {
    label: "Sound effects",
    blurb: "Short hits, whooshes, dings. Tag them so a render can ask for one kind.",
    accept: "audio/*",
  },
  motion: {
    label: "Motion overlay",
    blurb: "Transparent loops — light leaks, grain, particles. WebM or MOV with alpha.",
    accept: "video/*",
  },
  banner: {
    label: "Banner / logo",
    blurb: "A PNG with transparency, overlaid in a corner for the whole video.",
    accept: "image/*",
  },
  intro: { label: "Intro", blurb: "Played before the first scene.", accept: "video/*" },
  outro: { label: "Outro", blurb: "Played after the last scene.", accept: "video/*" },
  clip: {
    label: "Stock clip",
    blurb: "Reusable footage you can drop into any video as a scene.",
    accept: "video/*",
  },
};

function KindIcon({ kind, className }: { kind: AssetKind; className?: string }) {
  if (kind === "banner") return <IconImage className={className} />;
  if (kind === "music" || kind === "sfx") return <IconWave className={className} />;
  return <IconVideo className={className} />;
}

function prettySize(bytes: number): string {
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

export function AssetsManager() {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<AssetKind | "all">("all");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/assets", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as Payload);
    } catch {
      toast("Couldn't load the asset library.", "error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(
    () => (data?.assets ?? []).filter((a) => filter === "all" || a.kind === filter),
    [data, filter]
  );

  const counts = useMemo(() => {
    const out = {} as Record<AssetKind, number>;
    for (const k of ASSET_KINDS) out[k] = 0;
    for (const a of data?.assets ?? []) out[a.kind] = (out[a.kind] ?? 0) + 1;
    return out;
  }, [data]);

  async function remove(asset: Asset) {
    if (!window.confirm(`Delete "${asset.name}"?`)) return;
    setBusy(true);
    try {
      await fetch(`/api/admin/assets/${encodeURIComponent(asset.id)}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <div className="glass-card px-5 py-8 text-center text-sm text-muted">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-5">
      {!data.storageReady ? (
        <div className="flex gap-3 rounded-2xl border border-live/30 bg-liveSoft px-5 py-4">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-live" />
          <p className="text-[13px] leading-relaxed text-ink">
            <strong>Storage isn&apos;t ready.</strong> {data.hint}
          </p>
        </div>
      ) : null}

      <UploadCard
        disabled={!data.storageReady || busy}
        maxBytes={data.maxBytes}
        onUploaded={load}
      />

      {/* Kind filter with counts, so you can see which shelves are bare. */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`rounded-xl border px-3 py-1.5 text-[13px] font-medium transition-colors ${
            filter === "all"
              ? "border-brand-600 bg-brand-50 text-brand-700"
              : "border-line bg-white text-muted hover:text-ink"
          }`}
        >
          All <span className="text-faint">{data.assets.length}</span>
        </button>
        {ASSET_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setFilter(k)}
            className={`rounded-xl border px-3 py-1.5 text-[13px] font-medium transition-colors ${
              filter === k
                ? "border-brand-600 bg-brand-50 text-brand-700"
                : "border-line bg-white text-muted hover:text-ink"
            }`}
          >
            {KIND_HELP[k].label} <span className="text-faint">{counts[k]}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="glass-card px-5 py-10 text-center">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-brand-50 text-brand-600">
            <IconSparkle className="h-5 w-5" />
          </span>
          <p className="mt-3 text-[14px] font-medium text-ink">Nothing here yet</p>
          <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-muted">
            Upload music, overlays and banners once. Every backend — Colab, Kaggle or Modal — reads
            from this library, so there is nothing to copy onto a notebook.
          </p>
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <div className="divide-y divide-line">
            {shown.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-4 px-5 py-3.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                  <KindIcon kind={a.kind} className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[14px] font-medium text-ink">{a.name}</p>
                    <span className="rounded-full bg-surface3 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-faint">
                      {a.kind}
                    </span>
                    {a.tag ? (
                      <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10.5px] font-semibold text-brand-700">
                        {a.tag}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-[12px] text-muted">
                    {prettySize(a.sizeBytes)}
                    {a.durationSec ? ` · ${a.durationSec.toFixed(1)}s` : ""}
                  </p>
                  {a.kind === "music" || a.kind === "sfx" ? (
                    <audio
                      src={a.url}
                      controls
                      preload="none"
                      className="mt-2 h-8 w-full max-w-xs"
                    />
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(a)}
                  aria-label={`Delete ${a.name}`}
                  className="grid h-8 w-8 place-items-center rounded-lg text-faint transition-colors hover:bg-dangerSoft hover:text-danger disabled:opacity-40"
                >
                  <IconTrash className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UploadCard({
  disabled,
  maxBytes,
  onUploaded,
}: {
  disabled: boolean;
  maxBytes: number;
  onUploaded: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<AssetKind>("music");
  const [files, setFiles] = useState<File[]>([]);
  const [tag, setTag] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState("");

  /**
   * Read a media file's duration without decoding it, so the library can show
   * it. Best-effort: a failure here must not stop the upload.
   */
  async function durationOf(file: File): Promise<number | undefined> {
    const isMedia = file.type.startsWith("audio/") || file.type.startsWith("video/");
    if (!isMedia) return undefined;
    const url = URL.createObjectURL(file);
    try {
      return await new Promise<number | undefined>((resolve) => {
        const el = document.createElement(file.type.startsWith("audio/") ? "audio" : "video");
        el.preload = "metadata";
        el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? el.duration : undefined);
        el.onerror = () => resolve(undefined);
        el.src = url;
        setTimeout(() => resolve(undefined), 5000);
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Straight to Blob, then tell our API where it landed.
   *
   * The file deliberately does not pass through a Vercel function: anything
   * over 4.5 MB is rejected with FUNCTION_PAYLOAD_TOO_LARGE, which silently
   * capped uploads below the size of a typical music track.
   *
   * Sequential on purpose — one at a time lets a single bad file be named
   * without losing the rest of the batch.
   */
  async function uploadAll() {
    if (!files.length) return;
    setUploading(true);
    let ok = 0;
    try {
      for (const [i, file] of files.entries()) {
        setProgress(`${i + 1} of ${files.length} — ${file.name}`);
        try {
          if (file.size > maxBytes) {
            throw new Error(`over ${Math.round(maxBytes / 1024 / 1024)} MB`);
          }
          const mime = file.type || "application/octet-stream";
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
          const blob = await uploadDirect(
            "/api/admin/assets/upload",
            `assets/${kind}/${Date.now()}-${safeName}`,
            file,
            mime,
            { kind }
          );

          const res = await fetch("/api/admin/assets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind,
              name: file.name,
              tag: tag.trim() || undefined,
              url: blob.url,
              mime,
              sizeBytes: file.size,
              durationSec: await durationOf(file),
            }),
          });
          if (!res.ok) {
            const json = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(json.error ?? "could not be recorded");
          }
          ok++;
        } catch (e) {
          toast(`${file.name}: ${e instanceof Error ? e.message : "upload failed"}`, "error");
        }
      }
      if (ok) toast(`Uploaded ${ok} file${ok === 1 ? "" : "s"}.`, "success");
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
      onUploaded();
    } finally {
      setUploading(false);
      setProgress("");
    }
  }

  const help = KIND_HELP[kind];

  return (
    <div className="glass-card overflow-hidden">
      <div className="border-b border-line bg-surface2 px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">Upload</h2>
        <p className="mt-0.5 text-[12.5px] text-muted">
          Up to 50 MB per file. You can select several at once.
        </p>
      </div>

      <div className="space-y-4 px-5 py-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-muted" htmlFor="a-kind">
              Kind
            </label>
            <Select
              id="a-kind"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as AssetKind);
                setFiles([]);
                if (fileInput.current) fileInput.current.value = "";
              }}
            >
              {ASSET_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_HELP[k].label}
                </option>
              ))}
            </Select>
            <p className="mt-1.5 text-[12px] leading-relaxed text-faint">{help.blurb}</p>
          </div>
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-muted" htmlFor="a-tag">
              Tag <span className="text-faint">— optional</span>
            </label>
            <Input
              id="a-tag"
              value={tag}
              maxLength={40}
              placeholder={kind === "sfx" ? "whoosh" : "upbeat"}
              onChange={(e) => setTag(e.target.value)}
            />
            <p className="mt-1.5 text-[12px] leading-relaxed text-faint">
              Groups files so a render can ask for one kind specifically.
            </p>
          </div>
        </div>

        {/* The file input is its own control with a visible button — never
            wrapped in a label holding other inputs, which silently swallows
            the click. */}
        <div>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={help.accept}
            className="hidden"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" disabled={uploading} onClick={() => fileInput.current?.click()}>
              <IconUpload className="h-3.5 w-3.5" />
              Choose files
            </Button>
            <span className="text-[12.5px] text-muted">
              {files.length
                ? `${files.length} file${files.length === 1 ? "" : "s"} selected`
                : `Accepts ${help.accept}`}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-line bg-surface2 px-5 py-3">
        <p className="text-[12px] text-muted">
          {progress || "Stored once, used by every backend."}
        </p>
        <Button
          variant="primary"
          size="sm"
          className="ml-auto"
          disabled={!files.length || uploading || disabled}
          onClick={() => void uploadAll()}
        >
          {uploading ? "Uploading…" : "Upload"}
        </Button>
      </div>
    </div>
  );
}
