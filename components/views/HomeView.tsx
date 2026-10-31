"use client";

import Link from "next/link";
import { formatDuration } from "@/lib/audio";
import { useClipStatus } from "@/lib/clipClient";
import { anyPresenterReady, usePresenterStatus } from "@/lib/presenterClient";
import { useApp } from "@/lib/store";
import { GpuOfflineNotice } from "../studio/GpuOfflineNotice";
import {
  IconArrowRight,
  IconDownload,
  IconFilmSpark,
  IconLibrary,
  IconMic,
  IconScript,
  IconSparkle,
  IconVideo,
  IconWave,
} from "../ui/Icons";

const STEPS = [
  { n: 1, label: "Write", hint: "Paste a script or describe a scene", Icon: IconScript },
  { n: 2, label: "Choose a voice", hint: "Record yours once, use it everywhere", Icon: IconMic },
  { n: 3, label: "Generate", hint: "Watch it render, piece by piece", Icon: IconSparkle },
  { n: 4, label: "Download", hint: "Audio, subtitles or video", Icon: IconDownload },
];

type Availability = "ready" | "unavailable" | "checking";

function AvailabilityPill({ state }: { state: Availability }) {
  const s =
    state === "ready"
      ? { text: "Ready", wrap: "border-ready/30 bg-readySoft text-ready", dot: "bg-ready" }
      : state === "checking"
        ? { text: "Checking…", wrap: "border-line bg-surface2 text-muted", dot: "bg-faint" }
        : { text: "Not available right now", wrap: "border-line bg-surface2 text-muted", dot: "border border-faint" };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold ${s.wrap}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.text}
    </span>
  );
}

function ToolCard({
  href,
  title,
  description,
  Icon,
  tone,
  state,
  stat,
}: {
  href: string;
  title: string;
  description: string;
  Icon: typeof IconWave;
  tone: "audio" | "video";
  state: Availability;
  stat: string;
}) {
  return (
    <Link
      href={href}
      className={`glass-card group flex flex-col gap-4 p-5 transition-shadow sm:p-6 ${
        tone === "audio" ? "hover:shadow-glow" : "hover:shadow-glowVideo"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className={`grid h-11 w-11 place-items-center rounded-xl ${
            tone === "audio" ? "bg-audioSoft text-audio" : "bg-videoSoft text-video"
          }`}
        >
          <Icon className="h-5 w-5" />
        </span>
        <AvailabilityPill state={state} />
      </div>
      <div>
        <h2 className="font-display text-[17px] font-semibold text-ink">{title}</h2>
        <p className="mt-1 text-[13.5px] leading-relaxed text-muted">{description}</p>
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 pt-1">
        <span className="text-[12.5px] text-faint">{stat}</span>
        <span
          className={`inline-flex items-center gap-1 text-[13.5px] font-semibold ${
            tone === "audio" ? "text-audio" : "text-video"
          }`}
        >
          Open
          <IconArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}

/** Studio home: what you can make, whether it's available right now, and how it works. */
export function HomeView() {
  const speechReady = useApp((s) => s.backend.connected);
  const voices = useApp((s) => s.voices.length);
  const chunks = useApp((s) => s.project.chunks);
  const { status: presenterStatus } = usePresenterStatus();
  const { status: clipStatus } = useClipStatus();

  const done = chunks.filter((c) => c.status === "done");
  const doneSec = done.reduce((a, c) => a + (c.durationSec ?? 0), 0);
  const presenters = presenterStatus?.presenters.length ?? 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:py-12">
      <section className="mb-10 max-w-2xl">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Studio</p>
        <h1 className="font-display text-3xl font-bold leading-[1.15] tracking-tight text-ink sm:text-[40px]">
          Your voice, your face,
          <br />
          <span className="gradient-text">made on your own GPU.</span>
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-muted">
          Narration in your cloned voice, lip-synced presenter clips, and short AI video for b-roll and Shorts. No
          subscription: it all runs on GPUs you control.
        </p>
      </section>

      {!speechReady ? (
        <div className="mb-8">
          <GpuOfflineNotice what="create" />
        </div>
      ) : null}

      <section className="mb-10 grid gap-4 md:grid-cols-3" aria-label="Tools">
        <ToolCard
          href="/studio/speech"
          title="Text to Speech"
          description="Turn any script into narration in your own voice, in 23 languages."
          Icon={IconWave}
          tone="audio"
          state={speechReady ? "ready" : "unavailable"}
          stat={
            done.length
              ? `${done.length}/${chunks.length} pieces · ${formatDuration(doneSec)}`
              : voices
                ? `${voices} voice${voices > 1 ? "s" : ""} saved`
                : "No voice yet"
          }
        />
        <ToolCard
          href="/studio/presenter"
          title="Presenter Video"
          description="A presenter speaks your intro or outro, lip-synced to your voice."
          Icon={IconVideo}
          tone="video"
          state={presenterStatus ? (anyPresenterReady(presenterStatus) ? "ready" : "unavailable") : "checking"}
          stat={presenters ? `${presenters} presenter${presenters > 1 ? "s" : ""} saved` : "No presenter yet"}
        />
        <ToolCard
          href="/studio/ai-video"
          title="AI Video"
          description="Describe a scene and get a 5-second clip for b-roll, intros or Shorts."
          Icon={IconFilmSpark}
          tone="video"
          state={clipStatus ? (clipStatus.ready ? "ready" : "unavailable") : "checking"}
          stat="Wan 2.2 · commercial-use licence"
        />
      </section>

      <section className="mb-10" aria-labelledby="how-heading">
        <h2 id="how-heading" className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          How it works
        </h2>
        <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(({ n, label, hint, Icon }) => (
            <li key={n} className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface3 text-muted">
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="flex items-baseline gap-1.5 text-[13.5px] font-semibold text-ink">
                  <span className="font-mono text-[11px] text-faint">{n}</span>
                  {label}
                </p>
                <p className="mt-0.5 text-[12.5px] leading-snug text-muted">{hint}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <Link
        href="/studio/library"
        className="glass-card group flex items-center gap-4 px-5 py-4 transition-shadow hover:shadow-lift"
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface3 text-muted">
          <IconLibrary className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] font-semibold text-ink">My Library</span>
          <span className="block text-[13px] text-muted">Everything you&apos;ve made: play it again or download it.</span>
        </span>
        <IconArrowRight className="h-4 w-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
      </Link>
    </div>
  );
}
