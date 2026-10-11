"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LANGUAGES } from "@/lib/config";
import { usePresenterStatus } from "@/lib/presenterClient";
import { useApp } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { PresenterKind, PresenterView } from "@/lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card, CardHeader } from "../ui/Card";
import { CopyId } from "../ui/CopyId";
import { IconDownload, IconRefresh, IconSparkle, IconVideo } from "../ui/Icons";
import { Select } from "../ui/Select";

const MAX_CHARS = 900;
const LAST_CLIP_KEY = "vf:presenter-clip";
const POLL_MS = 5_000;

interface Clip {
  jobId: string;
  status: "queued" | "running" | "done" | "error";
  stage: string | null;
  backend: string | null;
  videoUrl: string | null;
  duration: number | null;
  genSeconds: number | null;
  error: string | null;
  createdAt: number;
  diagnostics: {
    engine?: string;
    sync?: { delivered?: { confidence?: number; offset_frames?: number } };
  } | null;
}

/** The two steps a text clip goes through, in the words shown while waiting. */
const STAGES: Array<{ key: string; label: string; hint: string }> = [
  { key: "narrating", label: "Narrating", hint: "Speaking your text in the chosen voice." },
  {
    key: "lip-syncing",
    label: "Lip-syncing",
    hint: "Redrawing the presenter's mouth to match. This is the slow part — a few minutes.",
  },
];

function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

function stageIndex(clip: Clip): number {
  if (clip.status === "done") return STAGES.length;
  const stage = clip.stage ?? "";
  if (stage === "narrating" || clip.status === "queued") return 0;
  return 1;
}

/**
 * Presenter video in the studio: type a line, pick who says it and in which
 * voice, and get a lip-synced clip back.
 *
 * One request does both steps. The server narrates the text, then hands the
 * narration to the lip-sync engine; this page only starts the job and polls
 * it. That is the same operation a workflow calls, so what you see here is
 * what n8n will get.
 */
export function VideoView() {
  const { status, failed, reload } = usePresenterStatus();
  const voices = useApp((s) => s.voices);
  const connect = useApp((s) => s.connect);

  const [text, setText] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [presenterId, setPresenterId] = useState("");
  const [starting, setStarting] = useState(false);
  const [clip, setClip] = useState<Clip | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // The voice list lives in the main store; make sure it has been read.
  useEffect(() => {
    if (!voices.length) void connect({ silent: true });
  }, [voices.length, connect]);

  // Sensible starting choices: the default voice and the default presenter.
  useEffect(() => {
    if (!voiceId && voices.length) {
      setVoiceId((voices.find((v) => v.isDefault) ?? voices[0]).id);
    }
  }, [voices, voiceId]);
  useEffect(() => {
    const list = status?.presenters ?? [];
    if (!presenterId && list.length) {
      setPresenterId((list.find((p) => p.isDefault) ?? list[0]).id);
    }
  }, [status, presenterId]);

  const poll = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/admin/presenter-clips/${encodeURIComponent(jobId)}`, {
        cache: "no-store",
      });
      if (res.status === 404) {
        setClip(null);
        try {
          localStorage.removeItem(LAST_CLIP_KEY);
        } catch {
          /* storage unavailable — nothing to clear */
        }
        return;
      }
      if (res.ok) setClip((await res.json()) as Clip);
    } catch {
      // A dropped poll is not a failed clip; the next one will catch up.
    }
  }, []);

  // Pick up the last clip after a reload, so a render in progress is not lost.
  useEffect(() => {
    try {
      const last = localStorage.getItem(LAST_CLIP_KEY);
      if (last) void poll(last);
    } catch {
      /* storage unavailable — start fresh */
    }
  }, [poll]);

  const active = clip && (clip.status === "queued" || clip.status === "running");

  useEffect(() => {
    if (!active || !clip) return;
    timer.current = setInterval(() => {
      setNow(Date.now());
      void poll(clip.jobId);
    }, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [active, clip, poll]);

  const voice = voices.find((v) => v.id === voiceId);
  const presenters = useMemo(() => status?.presenters ?? [], [status]);
  const presenter = presenters.find((p) => p.id === presenterId);
  const presenterReady = presenter ? status?.readiness[presenter.kind] : undefined;

  const blocker = !text.trim()
    ? "Type what the presenter should say."
    : text.length > MAX_CHARS
      ? `Keep it under ${MAX_CHARS} characters — this is for an intro or outro.`
      : !voice
        ? "Choose a voice."
        : !presenter
          ? "Choose a presenter."
          : presenterReady && !presenterReady.ready
            ? (presenterReady.reason ?? "This presenter can't be rendered right now.")
            : null;

  async function generate() {
    if (blocker || !voice || !presenter) return;
    setStarting(true);
    try {
      const res = await fetch("/api/admin/presenter-clips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), voiceId: voice.id, presenterId: presenter.id }),
      });
      const json = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (!res.ok || !json.jobId) throw new Error(json.error ?? "The clip could not be started.");
      try {
        localStorage.setItem(LAST_CLIP_KEY, json.jobId);
      } catch {
        /* storage unavailable — the clip still runs, it just won't survive a reload */
      }
      setNow(Date.now());
      setClip({
        jobId: json.jobId,
        status: "queued",
        stage: "narrating",
        backend: null,
        videoUrl: null,
        duration: null,
        genSeconds: null,
        error: null,
        createdAt: Date.now(),
        diagnostics: null,
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : "The clip could not be started.", "error");
    } finally {
      setStarting(false);
    }
  }

  /** The file is on another origin, where a plain download link just opens it. */
  async function download(url: string, jobId: string) {
    try {
      const blob = await (await fetch(url)).blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `presenter-${jobId.slice(0, 8)}.mp4`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch {
      window.open(url, "_blank", "noopener");
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 lg:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
            Presenter Video
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Type a line, choose who says it and in which voice, and get a lip-synced clip for your
            intro or outro.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={reload}>
            <IconRefresh className="h-3.5 w-3.5" />
            Refresh
          </Button>
          <Link
            href="/admin/presenters"
            className="inline-flex h-9 items-center rounded-xl border border-line bg-white px-4 text-[13px] font-medium text-ink transition-colors hover:border-lineStrong"
          >
            Manage presenters
          </Link>
        </div>
      </header>

      {failed ? (
        <Card>
          <p className="text-sm text-muted">
            Couldn&apos;t load the presenter library. Check that you&apos;re signed in, then
            refresh.
          </p>
        </Card>
      ) : !status ? (
        <Card>
          <p className="text-sm text-muted">Loading…</p>
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
          {/* ---------- what to make ---------- */}
          <div className="flex flex-col gap-5">
            {status.hint ? (
              <Card>
                <p className="text-sm text-ink">
                  <strong>Storage isn&apos;t ready.</strong> {status.hint}
                </p>
              </Card>
            ) : null}

            <Card>
              <CardHeader
                title="1 · What should they say?"
                description="An intro or an outro — a few sentences. Nepali, English or a mix is fine."
              />
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                placeholder="Hello everyone, and welcome back to the channel. Today I'm going to show you…"
                className="w-full resize-y rounded-xl border border-line bg-white px-4 py-3 text-[14px] leading-relaxed text-ink outline-none transition-colors placeholder:text-faint focus:border-brand-600"
              />
              <p
                className={`mt-1.5 text-right font-mono text-[11.5px] tabular-nums ${
                  text.length > MAX_CHARS ? "text-danger" : "text-faint"
                }`}
              >
                {text.length} / {MAX_CHARS}
              </p>
            </Card>

            <Card>
              <CardHeader
                title="2 · In which voice?"
                description="Any voice from your library. The language follows the voice."
              />
              {voices.length === 0 ? (
                <p className="text-sm text-muted">
                  No voices yet. Add one in{" "}
                  <Link href="/admin/voices" className="text-brand-700 underline">
                    Admin → Voices
                  </Link>
                  .
                </p>
              ) : (
                <>
                  <Select value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
                    {voices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} — {languageName(v.language)}
                        {v.isDefault ? " (default)" : ""}
                      </option>
                    ))}
                  </Select>
                  {voice ? (
                    <div className="mt-2.5 flex flex-wrap items-center gap-3">
                      <CopyId id={voice.id} label="Voice" />
                      <audio src={voice.audioUrl} controls preload="none" className="h-8 max-w-[220px]" />
                    </div>
                  ) : null}
                </>
              )}
            </Card>

            <Card>
              <CardHeader
                title="3 · Who says it?"
                description="A recording has its mouth redrawn to match. A still image is animated from nothing."
              />
              {presenters.length === 0 ? (
                <p className="text-sm text-muted">
                  No presenters yet. Add a recording or an image in{" "}
                  <Link href="/admin/presenters" className="text-video underline">
                    Admin → Presenters
                  </Link>
                  .
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {presenters.map((p) => (
                    <PresenterChoice
                      key={p.id}
                      presenter={p}
                      selected={p.id === presenterId}
                      readiness={status.readiness[p.kind]}
                      onSelect={() => setPresenterId(p.id)}
                    />
                  ))}
                </div>
              )}
            </Card>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="video"
                disabled={Boolean(blocker) || starting || Boolean(active)}
                onClick={() => void generate()}
              >
                <IconSparkle className="h-4 w-4" />
                {starting ? "Starting…" : active ? "Generating…" : "Generate video"}
              </Button>
              <p className="min-w-0 flex-1 text-[12.5px] text-muted">
                {active
                  ? "One clip at a time. You can leave this page; it carries on and will be here when you come back."
                  : (blocker ?? "Narrates your text, then lip-syncs it. Expect a few minutes.")}
              </p>
            </div>
          </div>

          {/* ---------- what came back ---------- */}
          <div className="flex flex-col gap-5">
            <Card accent="video">
              <CardHeader
                accent="video"
                icon={<IconVideo className="h-[18px] w-[18px]" />}
                title="Result"
                description="Your latest clip. It is stored, so the link keeps working."
              />
              {!clip ? (
                <div className="grid aspect-video place-items-center rounded-xl border border-dashed border-line bg-surface2/50 text-center">
                  <p className="px-6 text-[13px] text-muted">
                    Nothing generated yet. Fill in the three steps and press Generate.
                  </p>
                </div>
              ) : clip.status === "error" ? (
                <div className="rounded-xl border border-danger/30 bg-dangerSoft px-4 py-3">
                  <p className="text-[13.5px] font-medium text-danger">That clip failed.</p>
                  <p className="mt-1 break-words text-[12.5px] leading-relaxed text-ink">
                    {clip.error ?? "No reason was given."}
                  </p>
                </div>
              ) : clip.status === "done" && clip.videoUrl ? (
                <>
                  <video
                    key={clip.videoUrl}
                    src={clip.videoUrl}
                    controls
                    playsInline
                    className="aspect-video w-full rounded-xl bg-black object-contain"
                  />
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      variant="video"
                      size="sm"
                      onClick={() => void download(clip.videoUrl as string, clip.jobId)}
                    >
                      <IconDownload className="h-3.5 w-3.5" />
                      Download MP4
                    </Button>
                    <CopyId id={clip.videoUrl} label="Link" />
                  </div>
                  <ClipFacts clip={clip} />
                </>
              ) : (
                <Progress clip={clip} now={now} />
              )}
            </Card>

            <Card>
              <CardHeader
                title="Use it from n8n"
                description="The same operation, by id. Copy the ids from the cards on the left."
              />
              <pre className="overflow-x-auto rounded-xl bg-surface3 px-4 py-3 font-mono text-[11.5px] leading-relaxed text-ink">
                {`POST /api/v1/presenter
{
  "text": "Hello everyone, welcome back…",
  "voice_id": "${voice?.id ?? "<voice id>"}",
  "presenter_id": "${presenter?.id ?? "<presenter id>"}"
}`}
              </pre>
              <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
                It returns a job. Poll <code className="font-mono">/api/v1/jobs/&#123;id&#125;</code>{" "}
                until it is done, then pass its <code className="font-mono">video_url</code> to the
                video render as the intro or outro clip.
              </p>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function PresenterChoice({
  presenter,
  selected,
  readiness,
  onSelect,
}: {
  presenter: PresenterView;
  selected: boolean;
  readiness: { ready: boolean; provider?: string; reason?: string };
  onSelect(): void;
}) {
  const kindLabel: Record<PresenterKind, string> = { recording: "Recording", image: "Still image" };
  return (
    <div
      className={`overflow-hidden rounded-xl border transition-colors ${
        selected ? "border-video ring-2 ring-video/25" : "border-line hover:border-lineStrong"
      } ${readiness.ready ? "" : "opacity-70"}`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="block w-full text-left"
      >
        <div className="grid aspect-video place-items-center bg-surface3">
          {presenter.kind === "recording" ? (
            <video
              src={`${presenter.url}#t=0.5`}
              muted
              playsInline
              preload="metadata"
              className="h-full w-full object-contain"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={presenter.url} alt={presenter.name} className="h-full w-full object-contain" />
          )}
        </div>
        <div className="px-3 pt-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-[13.5px] font-medium text-ink">{presenter.name}</p>
            {presenter.isDefault ? <Badge tone="video">default</Badge> : null}
          </div>
          <p className="mt-0.5 text-[12px] text-muted">
            {kindLabel[presenter.kind]}
            {presenter.durationSec ? ` · ${presenter.durationSec.toFixed(1)}s` : ""}
          </p>
          {!readiness.ready ? (
            <p className="mt-1 text-[11.5px] leading-snug text-live">Not available yet</p>
          ) : null}
        </div>
      </button>
      <div className="px-3 pb-3 pt-2">
        <CopyId id={presenter.id} label="Presenter" />
      </div>
    </div>
  );
}

function Progress({ clip, now }: { clip: Clip; now: number }) {
  const at = stageIndex(clip);
  const elapsed = Math.max(0, Math.round((now - clip.createdAt) / 1000));
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");
  return (
    <div className="rounded-xl border border-line bg-surface2/50 px-4 py-4">
      <ol className="flex flex-col gap-3">
        {STAGES.map((s, i) => {
          const state = i < at ? "done" : i === at ? "now" : "next";
          return (
            <li key={s.key} className="flex items-start gap-3">
              <span
                className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
                  state === "done"
                    ? "bg-ready"
                    : state === "now"
                      ? "animate-pulse bg-live"
                      : "border border-faint"
                }`}
              />
              <div>
                <p
                  className={`text-[13.5px] font-medium ${
                    state === "next" ? "text-faint" : "text-ink"
                  }`}
                >
                  {s.label}
                  {state === "done" ? " — done" : state === "now" ? "…" : ""}
                </p>
                {state === "now" ? (
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{s.hint}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-4 font-mono text-[12px] tabular-nums text-muted">
        {mm}:{ss} elapsed{clip.backend ? ` · ${clip.backend}` : ""}
      </p>
    </div>
  );
}

/** How the clip turned out, in numbers — including whether it is in sync. */
function ClipFacts({ clip }: { clip: Clip }) {
  const sync = clip.diagnostics?.sync?.delivered;
  const facts: string[] = [];
  if (clip.duration) facts.push(`${clip.duration.toFixed(1)}s`);
  if (clip.genSeconds) facts.push(`made in ${Math.round(clip.genSeconds)}s`);
  if (clip.backend) facts.push(clip.backend);
  if (clip.diagnostics?.engine) facts.push(clip.diagnostics.engine);

  return (
    <div className="mt-3 space-y-1.5 text-[12.5px] text-muted">
      <p>{facts.join(" · ")}</p>
      {sync && typeof sync.confidence === "number" ? (
        <p>
          Lip-sync score{" "}
          <span className="font-mono text-ink">{sync.confidence.toFixed(1)}</span>
          {typeof sync.offset_frames === "number" ? (
            <>
              {" "}
              · offset <span className="font-mono text-ink">{sync.offset_frames}</span> frames
            </>
          ) : null}
          <span className="text-faint">
            {" "}
            — measured on the mouth only. Above 6 is good; an offset of 0 means the sound and
            picture start together.
          </span>
        </p>
      ) : null}
    </div>
  );
}
