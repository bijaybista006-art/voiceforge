"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CLIP_LENGTHS,
  EXAMPLE_PROMPTS,
  fetchClip,
  startClip,
  useClipStatus,
  type ClipJob,
} from "@/lib/clipClient";
import { confirmAction } from "@/lib/confirm";
import { PROVIDER_LABEL } from "@/lib/routingView";
import { toast } from "@/lib/toast";
import type { BackendProvider } from "@/lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card, CardHeader } from "../ui/Card";
import { CopyId } from "../ui/CopyId";
import { IconDownload, IconFilmSpark, IconRefresh, IconSparkle } from "../ui/Icons";
import { Input } from "../ui/Input";
import { ProgressBar } from "../ui/ProgressBar";
import { Select } from "../ui/Select";
import { Disclosure, PageHeader } from "../ui/Kit";
import { useIsAdmin } from "../studio/StudioContext";

const MAX_PROMPT = 2000;
const LAST_CLIP_KEY = "vf:ai-clip";
const POLL_MS = 5_000;

type Aspect = "landscape" | "vertical";

/**
 * AI Video in the studio: describe a scene, get a short Wan 2.2 clip back.
 *
 * This page only starts the job and polls it — the same operation
 * POST /api/v1/clips performs for n8n, so what you see here is what a
 * workflow gets. The last clip survives a reload (its id is kept in this
 * browser), so a render that takes several minutes is never lost by
 * leaving the page.
 */
export function ClipView() {
  const { status, failed, reload } = useClipStatus();
  const waitingForFree = !!status && (!status.ready || (!!status.paid && (status.skipped ?? []).some((x) => x.coming)));
  // reload is a new function each render; keep the latest without restarting the timer.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (!waitingForFree) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") reloadRef.current();
    }, 30_000);
    return () => clearInterval(id);
  }, [waitingForFree]);
  const isAdmin = useIsAdmin();

  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<Aspect>("landscape");
  const [quality, setQuality] = useState<"" | "720p" | "480p">("");
  const [frames, setFrames] = useState(121);
  const [negativePrompt, setNegativePrompt] = useState("");
  const [steps, setSteps] = useState(50);
  const [guidance, setGuidance] = useState(5);
  const [seed, setSeed] = useState("");

  const [starting, setStarting] = useState(false);
  const [clip, setClip] = useState<ClipJob | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const forget = useCallback(() => {
    try {
      localStorage.removeItem(LAST_CLIP_KEY);
    } catch {
      /* storage unavailable — nothing to clear */
    }
  }, []);

  const poll = useCallback(
    async (jobId: string) => {
      try {
        const next = await fetchClip(jobId);
        if (!next) {
          setClip(null);
          forget();
          return;
        }
        setClip(next);
      } catch {
        // A dropped poll is not a failed clip; the next one catches up.
      }
    },
    [forget]
  );

  // Pick up the last clip after a reload.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LAST_CLIP_KEY) ?? "null") as
        | { id: string; at: number }
        | null;
      if (saved?.id) {
        setStartedAt(saved.at ?? null);
        void poll(saved.id);
      }
    } catch {
      /* storage unavailable or old format — start fresh */
    }
  }, [poll]);

  const active = clip && (clip.status === "queued" || clip.status === "running");

  useEffect(() => {
    if (!active || !clip) return;
    timer.current = setInterval(() => {
      setNow(Date.now());
      void poll(clip.job_id);
    }, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [active, clip, poll]);

  const seedNumber = seed.trim() === "" ? undefined : Number(seed);
  const seedInvalid =
    seedNumber !== undefined && (!Number.isInteger(seedNumber) || seedNumber < 0 || seedNumber > 4294967295);

  const blocker = !prompt.trim()
    ? "Describe the scene you want."
    : prompt.length > MAX_PROMPT
      ? `Keep the prompt under ${MAX_PROMPT} characters.`
      : seedInvalid
        ? "The seed must be a whole number from 0 to 4294967295, or empty for random."
        : status && !status.ready
          ? isAdmin
            ? (status.reason ?? "No backend can make AI video right now.")
            : "AI video isn't available right now. Try again a little later."
          : null;

  async function generate() {
    if (blocker) return;
    // Never use the paid GPU silently while a free one is on its way.
    const coming = status?.paid ? (status.skipped ?? []).filter((x) => x.coming) : [];
    if (coming.length) {
      const ok = await confirmAction({
        title: `Use ${providerName(status?.provider)} (paid) for this clip?`,
        body: `${coming.map((x) => `${providerName(x.provider)}: ${x.reason}`).join(". ")}. You can wait for it instead: this page checks again every 30 seconds.`,
        confirmLabel: `Use ${providerName(status?.provider)}`,
      });
      if (!ok) return;
    }
    setStarting(true);
    try {
      const job = await startClip({
        prompt: prompt.trim(),
        aspect,
        ...(quality ? { quality } : {}),
        numFrames: frames,
        steps,
        guidance,
        ...(negativePrompt.trim() ? { negativePrompt: negativePrompt.trim() } : {}),
        ...(seedNumber !== undefined ? { seed: seedNumber } : {}),
      });
      const at = Date.now();
      try {
        localStorage.setItem(LAST_CLIP_KEY, JSON.stringify({ id: job.job_id, at }));
      } catch {
        /* storage unavailable — the clip still runs, it just won't survive a reload */
      }
      setStartedAt(at);
      setNow(at);
      setClip(job);
    } catch (e) {
      toast(e instanceof Error ? e.message : "The clip could not be started.", "error");
    } finally {
      setStarting(false);
    }
  }

  /** Load a finished clip's exact settings back into the form. */
  function reuse(job: ClipJob) {
    const s = job.settings;
    if (!s) return;
    if (s.prompt) setPrompt(s.prompt);
    if (s.aspect) setAspect(s.aspect);
    if (s.quality === "720p" || s.quality === "480p") setQuality(s.quality);
    if (s.num_frames) setFrames(s.num_frames);
    if (s.steps) setSteps(s.steps);
    if (s.guidance !== undefined) setGuidance(s.guidance);
    if (s.seed !== undefined) setSeed(String(s.seed));
    toast("Settings loaded. Same seed + same settings = the same clip; change the prompt to vary it.", "success");
  }

  /** The file is on another origin, where a plain download link just opens it. */
  async function download(url: string, job: ClipJob) {
    const slug = (job.settings?.prompt ?? "clip")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    const name = `${slug || "clip"}_seed${job.settings?.seed ?? "x"}.mp4`;
    try {
      const blob = await (await fetch(url)).blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch {
      window.open(url, "_blank", "noopener");
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-8 sm:px-6 lg:py-10">
      <PageHeader
        title="AI Video"
        description="Describe a scene and get a short clip for b-roll, intros or Shorts. Made with Wan 2.2 (Apache 2.0, fine for commercial YouTube use) on your own GPU."
        action={
          <>
            {status ? (
              <Badge tone={status.ready ? "video" : "neutral"} dot>
                {status.ready ? (isAdmin ? `Ready · ${status.provider}` : "Ready") : "Not available"}
              </Badge>
            ) : null}
            <Button size="sm" onClick={reload}>
              <IconRefresh className="h-3.5 w-3.5" />
              Refresh
            </Button>
          </>
        }
      />

      {failed ? (
        <Card>
          <p className="text-sm text-muted">
            Couldn&apos;t check the video backends. Check that you&apos;re signed in, then refresh.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
          {/* ---------- what to make ---------- */}
          <div className="flex min-w-0 flex-col gap-5">
            {status && !status.ready ? (
              <Card>
                {isAdmin ? (
                  <>
                    <p className="text-sm text-ink">
                      <strong>Not available yet.</strong> {status.reason}
                    </p>
                    <p className="mt-2 text-[12.5px] text-muted">
                      Already deployed? Press Test connection on that backend in{" "}
                      <Link href="/admin/backends" className="text-video underline">
                        Admin → Backends
                      </Link>
                      , then Refresh here.
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-ink">
                    <strong>AI video isn&apos;t available right now.</strong> You can still write your prompt and
                    set it up; try Refresh in a little while.
                  </p>
                )}
              </Card>
            ) : status?.ready && status.paid ? (
              <PaidNotice status={status} />
            ) : isAdmin && status?.also ? (
              <p className="text-[12.5px] text-muted">Also: {status.also}</p>
            ) : null}

            <Card>
              <CardHeader
                title="1 · Describe the scene"
                description="Say what is in it, what moves, how the camera moves, the light and the style."
              />
              <textarea
                aria-label="Scene description"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={5}
                placeholder="Aerial drone shot slowly flying over a misty mountain valley at sunrise, golden light, cinematic…"
                className="w-full resize-y rounded-xl border border-line bg-surface px-4 py-3 text-[14px] leading-relaxed text-ink outline-none transition-colors placeholder:text-faint focus:border-accent-600"
              />
              <div className="mt-1.5 flex flex-wrap items-start justify-between gap-2">
                <div className="flex flex-wrap gap-1.5">
                  {EXAMPLE_PROMPTS.map((ex) => (
                    <button
                      key={ex.label}
                      type="button"
                      onClick={() => {
                        setPrompt(ex.prompt);
                        if (ex.aspect) setAspect(ex.aspect);
                      }}
                      className="rounded-full border border-line bg-surface2 px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:border-video/40 hover:text-video"
                    >
                      {ex.label}
                    </button>
                  ))}
                </div>
                <p
                  className={`font-mono text-[11.5px] tabular-nums ${
                    prompt.length > MAX_PROMPT ? "text-danger" : "text-faint"
                  }`}
                >
                  {prompt.length} / {MAX_PROMPT}
                </p>
              </div>
            </Card>

            <Card>
              <CardHeader title="2 · Shape" description="Where the clip is going decides its shape." />
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <p className="mb-1.5 text-[12.5px] font-medium text-ink">Format</p>
                  <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Format">
                    {(
                      [
                        ["landscape", "16:9", "YouTube"],
                        ["vertical", "9:16", "Shorts"],
                      ] as const
                    ).map(([value, ratio, where]) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={aspect === value}
                        onClick={() => setAspect(value)}
                        className={`rounded-xl border px-2 py-2 text-center transition-colors ${
                          aspect === value
                            ? "border-video bg-videoSoft text-video ring-2 ring-video/20"
                            : "border-line bg-surface2 text-muted hover:border-lineStrong"
                        }`}
                      >
                        <span className="block font-mono text-[13px] font-semibold">{ratio}</span>
                        <span className="block text-[11px]">{where}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <label className="block">
                  <span className="mb-1.5 block text-[12.5px] font-medium text-ink">Quality</span>
                  <Select value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)}>
                    <option value="">
                      Backend default{status?.limits?.default_quality ? ` (${status.limits.default_quality})` : ""}
                    </option>
                    <option value="720p">720p — sharpest, slowest</option>
                    <option value="480p">480p — ~2.5× faster</option>
                  </Select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[12.5px] font-medium text-ink">Length</span>
                  <Select value={frames} onChange={(e) => setFrames(Number(e.target.value))}>
                    {CLIP_LENGTHS.map((l) => (
                      <option key={l.frames} value={l.frames}>
                        {l.label}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>

              <details className="group mt-4 rounded-xl border border-line bg-surface2/50 px-4 py-3">
                <summary className="cursor-pointer select-none text-[12.5px] font-medium text-muted group-open:text-ink">
                  Advanced — negative prompt, steps, guidance, seed
                </summary>
                <div className="mt-3 grid gap-4 sm:grid-cols-3">
                  <label className="block sm:col-span-3">
                    <span className="mb-1.5 block text-[12.5px] font-medium text-ink">Negative prompt</span>
                    <Input
                      value={negativePrompt}
                      onChange={(e) => setNegativePrompt(e.target.value)}
                      placeholder="Leave empty for the standard one (blurry, distorted, extra fingers…)"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[12.5px] font-medium text-ink">Steps · {steps}</span>
                    <input
                      type="range"
                      min={10}
                      max={100}
                      value={steps}
                      onChange={(e) => setSteps(Number(e.target.value))}
                      className="w-full accent-[#7c3aed]"
                    />
                    <span className="text-[11.5px] text-faint">Fewer is faster; 50 is the model&apos;s default.</span>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[12.5px] font-medium text-ink">
                      Guidance · {guidance.toFixed(1)}
                    </span>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      step={0.5}
                      value={guidance}
                      onChange={(e) => setGuidance(Number(e.target.value))}
                      className="w-full accent-[#7c3aed]"
                    />
                    <span className="text-[11.5px] text-faint">How strictly to follow the prompt.</span>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[12.5px] font-medium text-ink">Seed</span>
                    <Input
                      inputMode="numeric"
                      value={seed}
                      onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ""))}
                      placeholder="Random"
                    />
                    <span className="text-[11.5px] text-faint">Same seed + settings = same clip.</span>
                  </label>
                </div>
              </details>
            </Card>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="video"
                disabled={Boolean(blocker) || starting || Boolean(active) || !status}
                onClick={() => void generate()}
              >
                <IconSparkle className="h-4 w-4" />
                {starting ? "Starting…" : active ? "Generating…" : "Generate clip"}
              </Button>
              <p className="min-w-0 flex-1 text-[12.5px] text-muted">
                {!status
                  ? "Checking which backend can make clips…"
                  : active
                    ? "One clip at a time. You can leave this page; it carries on and will be here when you come back."
                    : (blocker ??
                      "Expect several minutes: roughly 5–10 on Modal, longer on a free notebook GPU. The first clip after a pause also loads the model.")}
              </p>
            </div>
          </div>

          {/* ---------- what came back ---------- */}
          <div className="flex min-w-0 flex-col gap-5">
            <Card accent="video">
              <CardHeader
                accent="video"
                icon={<IconFilmSpark className="h-[18px] w-[18px]" />}
                title="Result"
                description="Your latest clip. It is stored, so the link keeps working."
              />
              {!clip ? (
                <div className="grid aspect-video place-items-center rounded-xl border border-dashed border-line bg-surface2/50 text-center">
                  <p className="px-6 text-[13px] text-muted">
                    Nothing generated yet. Describe a scene and press Generate.
                  </p>
                </div>
              ) : clip.status === "error" ? (
                <div className="rounded-xl border border-danger/30 bg-dangerSoft px-4 py-3">
                  <p className="text-[13.5px] font-medium text-danger">That clip failed.</p>
                  <p className="mt-1 break-words text-[12.5px] leading-relaxed text-ink">
                    {clip.error ?? "No reason was given."}
                  </p>
                  {clip.error?.includes("GPU_OUT_OF_MEMORY") ? (
                    <p className="mt-2 text-[12.5px] text-muted">
                      Try 480p or a shorter length, or run it on Modal.
                    </p>
                  ) : null}
                </div>
              ) : clip.status === "done" && clip.video_url ? (
                <>
                  <video
                    key={clip.video_url}
                    src={clip.video_url}
                    controls
                    loop
                    playsInline
                    className={`w-full rounded-xl bg-black object-contain ${
                      clip.settings?.aspect === "vertical" ? "mx-auto aspect-[9/16] max-h-[560px]" : "aspect-video"
                    }`}
                  />
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button variant="video" size="sm" onClick={() => void download(clip.video_url as string, clip)}>
                      <IconDownload className="h-3.5 w-3.5" />
                      Download MP4
                    </Button>
                    {clip.settings ? (
                      <Button size="sm" onClick={() => reuse(clip)}>
                        Reuse settings
                      </Button>
                    ) : null}
                    <CopyId id={clip.video_url} label="Link" />
                  </div>
                  <ClipFacts clip={clip} />
                  <RoutedNote clip={clip} />
                </>
              ) : (
                <>
                  <ClipProgress clip={clip} startedAt={startedAt} now={now} />
                  <RoutedNote clip={clip} />
                </>
              )}
            </Card>

            {/* Automation details are for the admin only. */}
            {isAdmin ? (
              <Disclosure title="Use it from n8n" hint="The same operation through the API, with an API key.">
                <pre className="overflow-x-auto rounded-xl bg-surface3 px-4 py-3 font-mono text-[11.5px] leading-relaxed text-ink">
                  {`POST /api/v1/clips
{
  "prompt": "${(prompt.trim() || "Aerial drone shot over misty mountains…").slice(0, 60).replace(/"/g, '\\"')}${prompt.trim().length > 60 ? "…" : ""}",
  "aspect": "${aspect}",
  "num_frames": ${frames}${quality ? `,\n  "quality": "${quality}"` : ""}${seedNumber !== undefined && !seedInvalid ? `,\n  "seed": ${seedNumber}` : ""}
}`}
                </pre>
                <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
                  It returns a job. Poll <code className="font-mono">/api/v1/jobs/&#123;id&#125;</code> until it is
                  done; it carries <code className="font-mono">video_url</code> and the{" "}
                  <code className="font-mono">settings</code> used, seed included.
                </p>
              </Disclosure>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Minutes left, from how far the clip has come and how long that took. Only
 * once there is enough progress to extrapolate from; null before that.
 */
export function clipMinutesLeft(progress: number, elapsedSec: number | null): number | null {
  if (elapsedSec === null || progress < 8 || progress >= 100) return null;
  return Math.max(1, Math.round((elapsedSec * (100 - progress)) / progress / 60));
}

function ClipProgress({ clip, startedAt, now }: { clip: ClipJob; startedAt: number | null; now: number }) {
  const isAdmin = useIsAdmin();
  const progress = clip.progress ?? 0;
  const elapsed = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : null;
  const left = clipMinutesLeft(progress, elapsed);
  const stage =
    clip.status === "queued" || progress === 0
      ? "Waiting for the GPU…"
      : clip.stage
        ? clip.stage.charAt(0).toUpperCase() + clip.stage.slice(1)
        : "Generating…";
  return (
    <div className="rounded-xl border border-line bg-surface2/50 px-4 py-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
          <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-live" aria-hidden />
          {stage}
        </p>
        <span className="font-mono text-[12px] tabular-nums text-muted">{Math.round(progress)}%</span>
      </div>
      {progress > 0 ? (
        <ProgressBar value={progress} tone="live" label="Clip progress" />
      ) : (
        <ProgressBar indeterminate tone="live" label="Clip progress" />
      )}
      <p className="mt-3 text-[13px] font-medium text-ink" data-testid="clip-eta">
        {left !== null
          ? `About ${left} min left`
          : "Estimating time left… a clip usually takes several minutes."}
      </p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
        The GPU loads the model, then works on every frame together. A GPU that was asleep adds a minute or two
        before progress starts.
      </p>
      <p className="mt-3 font-mono text-[12px] tabular-nums text-muted">
        {elapsed !== null ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")} elapsed` : "running"}
        {isAdmin && clip.backend ? ` · ${clip.backend}` : ""}
      </p>
    </div>
  );
}

/** What the clip is, in numbers — enough to make it again. */
function providerName(p: string | undefined | null): string {
  return (p && PROVIDER_LABEL[p as BackendProvider]) || p || "another GPU";
}

/** Before generating: this would run on the paid GPU, and why the free ones can't. */
function PaidNotice({ status }: { status: NonNullable<ReturnType<typeof useClipStatus>["status"]> }) {
  const skipped = status.skipped ?? [];
  const coming = skipped.some((x) => x.coming);
  return (
    <div
      data-testid="paid-notice"
      className="rounded-2xl border border-live/30 bg-liveSoft px-5 py-4 text-[13px] leading-relaxed text-ink"
    >
      <p className="font-semibold">
        The next clip will run on {providerName(status.provider)}, which is paid.
      </p>
      {skipped.length ? (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted">
          {skipped.map((x) => (
            <li key={x.provider}>
              <span className="font-medium text-ink">{providerName(x.provider)}</span>: {x.reason}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-muted">No free GPU (Colab or Kaggle) is running.</p>
      )}
      {coming ? (
        <p className="mt-1.5 text-muted">
          Wait and it switches to the free GPU by itself once it is ready; this page checks every 30 seconds.
        </p>
      ) : null}
    </div>
  );
}

/** After: where it ran, and why not on the free GPUs. */
function RoutedNote({ clip }: { clip: ClipJob }) {
  if (!clip.skipped?.length) return null;
  return (
    <p className="mt-3 text-[12px] leading-relaxed text-muted" data-testid="routed-note">
      Made on {providerName(clip.backend)} because {clip.skipped.join("; ")}.
    </p>
  );
}

function ClipFacts({ clip }: { clip: ClipJob }) {
  const isAdmin = useIsAdmin();
  const s = clip.settings;
  const facts: string[] = [];
  if (s?.width && s?.height) facts.push(`${s.width}×${s.height}`);
  if (clip.duration) facts.push(`${clip.duration.toFixed(1)}s`);
  if (clip.gen_seconds) facts.push(`made in ${Math.round(clip.gen_seconds / 60)} min`);
  if (isAdmin && clip.backend) facts.push(clip.backend);
  return (
    <div className="mt-3 space-y-1.5 text-[12.5px] text-muted">
      <p>{facts.join(" · ")}</p>
      {s ? (
        <p>
          Seed <span className="font-mono text-ink">{s.seed}</span> · {s.steps} steps · guidance{" "}
          <span className="font-mono text-ink">{s.guidance}</span>
          {isAdmin && s.profile === "low_vram" ? <span className="text-faint"> · 4-bit (notebook)</span> : null}
        </p>
      ) : null}
    </div>
  );
}
