"use client";

import { formatDuration } from "@/lib/audio";
import { useApp } from "@/lib/store";
import { anyPresenterReady, usePresenterStatus } from "@/lib/presenterClient";
import { useClipStatus } from "@/lib/clipClient";
import type { ViewId } from "../Shell";
import { SpeechConnectionForm } from "../Connections";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card, CardHeader } from "../ui/Card";
import {
  IconArrowRight,
  IconDownload,
  IconFilmSpark,
  IconMic,
  IconScript,
  IconSparkle,
  IconVideo,
  IconWave,
} from "../ui/Icons";

const STEPS = [
  { n: 1, label: "Write script", hint: "Paste or type your narration", Icon: IconScript },
  { n: 2, label: "Select voice", hint: "Clone yours once, use it anywhere", Icon: IconMic },
  { n: 3, label: "Generate", hint: "Chunk by chunk, resumable", Icon: IconSparkle },
  { n: 4, label: "Download", hint: "WAV, MP3, SRT or MP4", Icon: IconDownload },
];

function Workflow() {
  return (
    <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {STEPS.map(({ n, label, hint, Icon }, i) => (
        <li key={n} className="relative">
          <div className="flex h-full items-start gap-3 rounded-xl border border-line bg-surface2/50 p-4">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface3 text-muted">
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="flex items-baseline gap-1.5 text-[13px] font-semibold text-ink">
                <span className="font-mono text-[11px] text-faint">{n}</span>
                {label}
              </p>
              <p className="mt-0.5 text-[12px] leading-snug text-muted">{hint}</p>
            </div>
          </div>
          {i < STEPS.length - 1 ? (
            <IconArrowRight
              className="absolute -right-2.5 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-line lg:block"
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function ProductCard({
  kind,
  onOpen,
}: {
  kind: "speech" | "video";
  onOpen(): void;
}) {
  const speechReady = useApp((s) => s.backend.connected);
  const { status: presenterStatus } = usePresenterStatus();
  const videoReady = anyPresenterReady(presenterStatus);
  const presenters = presenterStatus?.presenters.length ?? 0;
  const voices = useApp((s) => s.voices.length);
  const chunks = useApp((s) => s.project.chunks);

  const done = chunks.filter((c) => c.status === "done");
  const doneSec = done.reduce((a, c) => a + (c.durationSec ?? 0), 0);

  const isSpeech = kind === "speech";
  const ready = isSpeech ? speechReady : videoReady;

  const stat = isSpeech
    ? done.length
      ? `${done.length}/${chunks.length} chunks · ${formatDuration(doneSec)}`
      : voices
        ? `${voices} voice${voices > 1 ? "s" : ""} saved`
        : "No voice yet"
    : presenters
      ? `${presenters} presenter${presenters > 1 ? "s" : ""} saved`
      : "No presenter yet";

  return (
    <Card
      accent={isSpeech ? "audio" : "video"}
      interactive
      className={`group flex flex-col ${isSpeech ? "hover:shadow-glow" : "hover:shadow-glowVideo"}`}
    >
      <CardHeader
        accent={isSpeech ? "audio" : "video"}
        icon={isSpeech ? <IconWave className="h-[18px] w-[18px]" /> : <IconVideo className="h-[18px] w-[18px]" />}
        title={isSpeech ? "Text to Speech" : "Presenter Video"}
        description={
          isSpeech
            ? "Clone your voice once, then turn any script into narration — in 23 languages."
            : "Lip-synced intro and outro clips, spoken in your voice by a presenter you choose."
        }
        action={
          <Badge tone={ready ? (isSpeech ? "audio" : "video") : "neutral"} dot>
            {ready ? "Ready" : isSpeech ? "Offline" : "Not available"}
          </Badge>
        }
      />
      <div className="mt-auto flex items-center justify-between gap-3 pt-1">
        <span className="font-mono text-[11.5px] tabular-nums text-faint">{stat}</span>
        <Button variant={isSpeech ? "primary" : "video"} onClick={onOpen}>
          Open
          <IconArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}

/** AI video (Wan): ready when a backend reports text-to-video. */
function ClipCard({ onOpen }: { onOpen(): void }) {
  const { status } = useClipStatus();
  const ready = Boolean(status?.ready);
  const stat = !status
    ? "Checking…"
    : ready
      ? `on ${status.provider}${status.limits?.default_quality ? ` · ${status.limits.default_quality}` : ""}`
      : "No video backend yet";
  return (
    <Card accent="video" interactive className="group flex flex-col hover:shadow-glowVideo">
      <CardHeader
        accent="video"
        icon={<IconFilmSpark className="h-[18px] w-[18px]" />}
        title="AI Video"
        description="Describe a scene, get a 5-second clip for b-roll, intros or Shorts. Wan 2.2, commercial-use licence."
        action={
          <Badge tone={ready ? "video" : "neutral"} dot>
            {ready ? "Ready" : "Not available"}
          </Badge>
        }
      />
      <div className="mt-auto flex items-center justify-between gap-3 pt-1">
        <span className="font-mono text-[11.5px] tabular-nums text-faint">{stat}</span>
        <Button variant="video" onClick={onOpen}>
          Open
          <IconArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}

export function HomeView({ onNavigate }: { onNavigate(v: ViewId): void }) {
  const speechReady = useApp((s) => s.backend.connected);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:py-12">
      {/* hero */}
      <div className="stagger">
        <div className="mb-9 max-w-2xl">
          <Badge tone={speechReady ? "audio" : "neutral"} dot className="mb-4">
            {speechReady ? "GPU connected" : "Bring your own free GPU"}
          </Badge>
          <h1 className="font-display text-3xl font-bold leading-[1.15] tracking-tight text-ink sm:text-[40px]">
            Your voice, your face,
            <br />
            <span className="text-audio">rendered on your own GPU.</span>
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-muted">
            A studio for long-form narration, presenter video and AI clips. No subscription — the models run
            on GPUs you control, and your voices and presenters are stored once for every backend
            to use.
          </p>
        </div>

        {/* workflow */}
        <section className="mb-9" aria-label="How it works">
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
            How it works
          </h2>
          <Workflow />
        </section>

        {/* products */}
        <section className="mb-9 grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Tools">
          <ProductCard kind="speech" onOpen={() => onNavigate("speech")} />
          <ProductCard kind="video" onOpen={() => onNavigate("video")} />
          <ClipCard onOpen={() => onNavigate("clips")} />
        </section>

        {/* setup — only nags while there's genuinely nothing connected */}
        {!speechReady ? (
          <Card>
            <CardHeader
              title="Start a GPU to begin"
              description="Run the notebook from the repo on Colab or Kaggle with a T4 GPU. It registers itself — there is no URL to paste. Takes about four minutes."
            />
            <SpeechConnectionForm />
          </Card>
        ) : null}
      </div>
    </div>
  );
}
