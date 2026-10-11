"use client";

import { upload } from "@vercel/blob/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import type { PresenterKind, PresenterSource, PresenterView } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { CopyId } from "@/components/ui/CopyId";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import {
  IconAlert,
  IconCheck,
  IconImage,
  IconSparkle,
  IconTrash,
  IconUpload,
  IconVideo,
} from "@/components/ui/Icons";

interface Readiness {
  ready: boolean;
  provider?: string;
  reason?: string;
  also?: string;
}

interface Payload {
  presenters: PresenterView[];
  storageReady: boolean;
  hint: string | null;
  limits: { recordingBytes: number; imageBytes: number; minSeconds: number; maxSeconds: number };
  readiness: Record<PresenterKind, Readiness>;
}

const KIND_HELP: Record<
  PresenterKind,
  { label: string; blurb: string; accept: string; how: string }
> = {
  recording: {
    label: "A recording",
    blurb:
      "About 15 seconds of the presenter facing the camera and talking, in good light with the mouth clearly visible. What they say doesn't matter.",
    accept: "video/mp4,video/quicktime,video/webm",
    how: "Only the mouth is redrawn to match each new line. Everything else stays real footage, so this looks the most natural.",
  },
  image: {
    label: "A still image",
    blurb: "One clear, front-facing picture. Use this for an illustrated or AI-generated presenter.",
    accept: "image/png,image/jpeg,image/webp",
    how: "The whole clip is generated from the picture, which needs a much larger GPU than a recording does.",
  },
};

const SOURCE_LABEL: Record<PresenterSource, string> = {
  self: "It's me",
  generated: "AI-generated or fictional",
  permission: "A real person who gave permission",
};

function prettySize(bytes: number): string {
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

export function PresentersManager() {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/presenters", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as Payload);
    } catch {
      toast("Couldn't load the presenters.", "error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function makeDefault(p: PresenterView) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/presenters/${encodeURIComponent(p.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default: true }),
      });
      if (!res.ok) toast("Couldn't change the default.", "error");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: PresenterView) {
    if (!window.confirm(`Delete "${p.name}"? The file is removed too.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/admin/presenters/${encodeURIComponent(p.id)}`, { method: "DELETE" });
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
      {/* Driven by the hint, not by whether credentials exist: an outage or a
          blown quota leaves the credentials in place and the library empty. */}
      {data.hint ? (
        <div className="flex gap-3 rounded-2xl border border-live/30 bg-liveSoft px-5 py-4">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-live" />
          <p className="text-[13px] leading-relaxed text-ink">
            <strong>Storage isn&apos;t ready.</strong> {data.hint}
          </p>
        </div>
      ) : null}

      <ReadinessCard readiness={data.readiness} />

      <UploadCard
        disabled={!data.storageReady || busy}
        limits={data.limits}
        onUploaded={load}
      />

      {data.presenters.length === 0 ? (
        <div className="glass-card px-5 py-10 text-center">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-brand-50 text-brand-600">
            <IconSparkle className="h-5 w-5" />
          </span>
          <p className="mt-3 text-[14px] font-medium text-ink">No presenters yet</p>
          <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-muted">
            Upload a short recording of yourself or a still image. The first one becomes the
            default, and a workflow can name a different one for any single video.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {data.presenters.map((p) => {
            const ready = data.readiness[p.kind];
            return (
              <div key={p.id} className="glass-card overflow-hidden">
                <div className="grid aspect-video place-items-center bg-surface3">
                  {p.kind === "recording" ? (
                    <video
                      src={p.url}
                      controls
                      preload="metadata"
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.url} alt={p.name} className="h-full w-full object-contain" />
                  )}
                </div>
                <div className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[14px] font-medium text-ink">{p.name}</p>
                    {p.isDefault ? (
                      <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10.5px] font-semibold text-brand-700">
                        default
                      </span>
                    ) : null}
                    <span className="rounded-full bg-surface3 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-faint">
                      {p.kind}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] text-muted">
                    {prettySize(p.sizeBytes)}
                    {p.durationSec ? ` · ${p.durationSec.toFixed(1)}s` : ""}
                    {` · ${SOURCE_LABEL[p.source]}`}
                  </p>
                  {/* The id a workflow sends as presenter_id — shown in full and
                      copyable, like a voice id. */}
                  <div className="mt-2">
                    <CopyId id={p.id} label="Presenter" />
                  </div>
                  <p className={`mt-2 text-[12px] ${ready.ready ? "text-muted" : "text-live"}`}>
                    {ready.ready
                      ? `Would render on ${ready.provider}.`
                      : "Can't be rendered yet — see above."}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      size="sm"
                      disabled={busy || p.isDefault}
                      onClick={() => void makeDefault(p)}
                    >
                      <IconCheck className="h-3.5 w-3.5" />
                      {p.isDefault ? "Default" : "Make default"}
                    </Button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(p)}
                      aria-label={`Delete ${p.name}`}
                      className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-faint transition-colors hover:bg-dangerSoft hover:text-danger disabled:opacity-40"
                    >
                      <IconTrash className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Says, per kind, whether anything connected can actually render it. The
 * library is useful before an engine exists — you can upload and choose a
 * default — but it should never look as though clips will appear when no
 * backend is able to make them.
 */
function ReadinessCard({ readiness }: { readiness: Record<PresenterKind, Readiness> }) {
  return (
    <div className="glass-card overflow-hidden">
      <div className="border-b border-line bg-surface2 px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">What can be rendered right now</h2>
        <p className="mt-0.5 text-[12.5px] text-muted">
          Presenter video follows the same backend order as voice. Switch it on or off per backend
          in Admin → Backends.
        </p>
      </div>
      <div className="divide-y divide-line">
        {(Object.keys(KIND_HELP) as PresenterKind[]).map((kind) => {
          const r = readiness[kind];
          return (
            <div key={kind} className="flex items-start gap-3 px-5 py-3.5">
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${r.ready ? "bg-ready" : "bg-faint"}`}
              />
              <div className="min-w-0">
                <p className="text-[13.5px] font-medium text-ink">
                  {KIND_HELP[kind].label}
                  <span className="ml-2 text-[12px] font-normal text-muted">
                    {r.ready ? `ready on ${r.provider}` : "not available"}
                  </span>
                </p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">
                  {r.ready ? KIND_HELP[kind].how : r.reason}
                </p>
                {r.ready && r.also ? (
                  <p className="mt-1 text-[12.5px] leading-relaxed text-live">Meanwhile — {r.also}.</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UploadCard({
  disabled,
  limits,
  onUploaded,
}: {
  disabled: boolean;
  limits: Payload["limits"];
  onUploaded: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<PresenterKind>("recording");
  const [name, setName] = useState("");
  const [source, setSource] = useState<PresenterSource>("self");
  const [confirmed, setConfirmed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const help = KIND_HELP[kind];
  const maxBytes = kind === "recording" ? limits.recordingBytes : limits.imageBytes;

  /** Best-effort: a failure to read the length must not block the upload. */
  async function durationOf(f: File): Promise<number | undefined> {
    if (!f.type.startsWith("video/")) return undefined;
    const url = URL.createObjectURL(f);
    try {
      return await new Promise<number | undefined>((resolve) => {
        const el = document.createElement("video");
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

  function reset() {
    setFile(null);
    setName("");
    setConfirmed(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  /**
   * Straight to Blob, then tell our API where it landed. The file never
   * passes through a Vercel function, which would reject anything over 4.5 MB.
   */
  async function submit() {
    if (!file) return;
    setUploading(true);
    try {
      if (file.size > maxBytes) {
        throw new Error(`That file is over ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      }
      const durationSec = await durationOf(file);
      if (kind === "recording" && durationSec !== undefined) {
        if (durationSec < limits.minSeconds) {
          throw new Error(`That recording is too short — use at least ${limits.minSeconds}s.`);
        }
        if (durationSec > limits.maxSeconds) {
          throw new Error(`That recording is too long — trim it to ${limits.maxSeconds}s.`);
        }
      }

      const mime = file.type || "application/octet-stream";
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
      const blob = await upload(`presenters/${kind}/${Date.now()}-${safeName}`, file, {
        access: "public",
        contentType: mime,
        handleUploadUrl: "/api/admin/presenters/upload",
        clientPayload: JSON.stringify({ kind }),
      });

      const res = await fetch("/api/admin/presenters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || file.name.replace(/\.[^.]+$/, ""),
          kind,
          url: blob.url,
          mime,
          sizeBytes: file.size,
          durationSec,
          source,
          confirmed,
        }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? "The presenter could not be recorded.");
      }
      toast("Presenter added.", "success");
      reset();
      onUploaded();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Upload failed.", "error");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="glass-card overflow-hidden">
      <div className="border-b border-line bg-surface2 px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">Add a presenter</h2>
        <p className="mt-0.5 text-[12.5px] text-muted">
          Recordings up to {Math.round(limits.recordingBytes / 1024 / 1024)} MB and{" "}
          {limits.maxSeconds}s. Images up to {Math.round(limits.imageBytes / 1024 / 1024)} MB.
        </p>
      </div>

      <div className="space-y-4 px-5 py-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-muted" htmlFor="p-kind">
              Made from
            </label>
            <Select
              id="p-kind"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as PresenterKind);
                setFile(null);
                if (fileInput.current) fileInput.current.value = "";
              }}
            >
              {(Object.keys(KIND_HELP) as PresenterKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_HELP[k].label}
                </option>
              ))}
            </Select>
            <p className="mt-1.5 text-[12px] leading-relaxed text-faint">{help.blurb}</p>
          </div>
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-muted" htmlFor="p-name">
              Name
            </label>
            <Input
              id="p-name"
              value={name}
              maxLength={80}
              placeholder="Bijay — office"
              onChange={(e) => setName(e.target.value)}
            />
            <p className="mt-1.5 text-[12px] leading-relaxed text-faint">
              How you&apos;ll recognise it when choosing one for a video.
            </p>
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-[12.5px] font-medium text-muted" htmlFor="p-source">
            Whose face is it?
          </label>
          <Select
            id="p-source"
            value={source}
            onChange={(e) => {
              setSource(e.target.value as PresenterSource);
              setConfirmed(false);
            }}
          >
            {(Object.keys(SOURCE_LABEL) as PresenterSource[]).map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </Select>
          <label className="mt-2.5 flex cursor-pointer items-start gap-2.5 text-[12.5px] leading-relaxed text-muted">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-line"
            />
            <span>
              {source === "self"
                ? "This is my own face and I'm choosing to have it speak my scripts."
                : source === "generated"
                  ? "This face is generated or fictional and is not a real person."
                  : "This person has given me explicit permission to make videos of them speaking."}
            </span>
          </label>
        </div>

        {/* Its own control with a visible button — never wrapped in a label
            holding other inputs, which silently swallows the click. */}
        <div>
          <input
            ref={fileInput}
            type="file"
            accept={help.accept}
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" disabled={uploading} onClick={() => fileInput.current?.click()}>
              <IconUpload className="h-3.5 w-3.5" />
              Choose file
            </Button>
            <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
              {kind === "recording" ? (
                <IconVideo className="h-3.5 w-3.5" />
              ) : (
                <IconImage className="h-3.5 w-3.5" />
              )}
              {file ? `${file.name} · ${prettySize(file.size)}` : "No file chosen"}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-line bg-surface2 px-5 py-3">
        <p className="text-[12px] text-muted">
          {confirmed ? "Stored once, used by every backend." : "Tick the confirmation to continue."}
        </p>
        <Button
          variant="primary"
          size="sm"
          className="ml-auto"
          disabled={!file || !confirmed || uploading || disabled}
          onClick={() => void submit()}
        >
          {uploading ? "Uploading…" : "Add presenter"}
        </Button>
      </div>
    </div>
  );
}
