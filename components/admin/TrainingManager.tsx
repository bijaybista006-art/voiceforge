"use client";

import { SkeletonCard } from "@/components/ui/Kit";
import { confirmAction } from "@/lib/confirm";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeAudioBlob, encodeWavPcm16, formatDuration, type PcmAudio } from "@/lib/audio";
import {
  MAX_CLIP_SEC,
  TARGET_MINUTES,
  TRAINING_SAMPLE_RATE,
  analyzeClip,
  blocks,
  checkClip,
  checkTranscript,
  trimToSpeech,
  type ClipIssue,
  type ClipMetrics,
  type TrainingLanguage,
} from "@/lib/trainingChecks";
import { TRAINING_PROMPTS, nextPrompt, type TrainingPrompt } from "@/lib/trainingPrompts";
import { toast } from "@/lib/toast";
import type { TrainingSample, TrainingSummary } from "@/lib/types";
import { buildReference } from "@/lib/voiceReference";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { ProgressBar } from "@/components/ui/ProgressBar";
import {
  IconAlert,
  IconCheck,
  IconDownload,
  IconEdit,
  IconMic,
  IconTrash,
  IconUpload,
  IconWave,
} from "@/components/ui/Icons";

interface Payload {
  samples: TrainingSample[];
  summary: TrainingSummary[];
  speakers: string[];
  storageReady: boolean;
  hint: string | null;
}

const SPEAKER_KEY = "vf:training-speaker";

function rememberSpeaker(name: string) {
  try {
    localStorage.setItem(SPEAKER_KEY, name);
  } catch {
    /* private window: just not remembered */
  }
}

function recalledSpeaker(): string {
  try {
    return localStorage.getItem(SPEAKER_KEY) ?? "";
  } catch {
    return "";
  }
}

const LANGS: Array<{ code: TrainingLanguage; name: string }> = [
  { code: "ne", name: "Nepali — नेपाली" },
  { code: "en", name: "English" },
];

/**
 * Resample with the browser's own resampler. Plain linear interpolation, fine
 * for playback, aliases when going from 48 kHz down — and training data
 * keeps every artefact it is given.
 */
async function to24k(pcm: PcmAudio): Promise<PcmAudio> {
  if (pcm.sampleRate === TRAINING_SAMPLE_RATE) return pcm;
  const length = Math.ceil((pcm.samples.length * TRAINING_SAMPLE_RATE) / pcm.sampleRate);
  const ctx = new OfflineAudioContext(1, length, TRAINING_SAMPLE_RATE);
  const buf = ctx.createBuffer(1, pcm.samples.length, pcm.sampleRate);
  buf.copyToChannel(new Float32Array(pcm.samples), 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return { samples: out.getChannelData(0).slice(), sampleRate: TRAINING_SAMPLE_RATE };
}

interface Capture {
  pcm: PcmAudio;
  metrics: ClipMetrics;
  clipIssues: ClipIssue[];
  url: string;
}

export function TrainingManager() {
  const [data, setData] = useState<Payload | null>(null);
  const [language, setLanguage] = useState<TrainingLanguage>("ne");
  const [speaker, setSpeakerState] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const latest = useRef(0);

  function setSpeaker(name: string) {
    rememberSpeaker(name);
    setSpeakerState(name);
  }

  // Speaker is null until it is read back, so the first load is already filtered.
  useEffect(() => setSpeakerState(recalledSpeaker()), []);

  const load = useCallback(async () => {
    if (speaker === null) return;
    const ticket = ++latest.current;
    try {
      const q = speaker ? `?speaker=${encodeURIComponent(speaker)}` : "";
      const res = await fetch(`/api/admin/training${q}`, { cache: "no-store" });
      if (!res.ok || ticket !== latest.current) return;
      const json = (await res.json()) as Payload;
      setData(json);
      // First visit: carry on with whoever already has clips.
      if (!speaker && json.speakers.length) setSpeaker(json.speakers[0]);
    } catch {
      toast("Couldn't load the training clips.", "error");
    }
  }, [speaker]);

  useEffect(() => {
    void load();
  }, [load]);

  const samples = useMemo(
    () => (data?.samples ?? []).filter((s) => s.language === language),
    [data, language]
  );

  async function remove(s: TrainingSample) {
    const ok = await confirmAction({
      title: "Delete this clip?",
      body: "The recording and its transcript are removed from storage. This can't be undone.",
      confirmLabel: "Delete clip",
      danger: true,
    });
    if (!ok) return;
    setBusy(`del-${s.id}`);
    try {
      const res = await fetch(`/api/admin/training/${s.id}`, { method: "DELETE" });
      if (!res.ok) toast("Couldn't delete that clip.", "error");
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit(s: TrainingSample, text: string, description: string): Promise<boolean> {
    setBusy(`edit-${s.id}`);
    try {
      const res = await fetch(`/api/admin/training/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, description }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast(json.error ?? "Couldn't save the change.", "error");
        return false;
      }
      await load();
      return true;
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return (
      <div className="grid gap-3" aria-busy="true" aria-label="Loading">
        <SkeletonCard lines={3} />
        <SkeletonCard lines={2} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {data.hint ? (
        <div className="flex gap-3 rounded-2xl border border-live/30 bg-liveSoft px-5 py-4">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-live" />
          <p className="text-[13px] leading-relaxed text-ink">
            <strong>Storage isn&apos;t ready.</strong> {data.hint}
          </p>
        </div>
      ) : null}

      <SpeakerBar speakers={data.speakers} speaker={speaker ?? ""} onPick={setSpeaker} />

      <Progress summary={data.summary} language={language} onPick={setLanguage} />

      <AddClipCard
        key={`${language}|${speaker}`}
        language={language}
        speaker={speaker ?? ""}
        recordedPrompts={new Set(samples.map((s) => s.promptId).filter(Boolean) as string[])}
        disabled={!data.storageReady}
        onSaved={load}
      />

      <ReferenceCard
        key={`ref|${language}|${speaker}`}
        language={language}
        speaker={speaker ?? ""}
        samples={samples}
      />

      <ClipList
        language={language}
        speaker={speaker ?? ""}
        samples={samples}
        busy={busy}
        onDelete={remove}
        onSaveEdit={saveEdit}
      />
    </div>
  );
}

// --- speaker -----------------------------------------------------------------

/**
 * Whose clips these are. A training run learns one person's voice, so every
 * clip belongs to a speaker and the page shows one speaker's set at a time.
 */
function SpeakerBar({
  speakers,
  speaker,
  onPick,
}: {
  speakers: string[];
  speaker: string;
  onPick: (name: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const known = speaker && !speakers.some((s) => s.toLowerCase() === speaker.toLowerCase()) ? [...speakers, speaker] : speakers;
  const showInput = adding || known.length === 0;

  function add() {
    const name = draft.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!name) return;
    onPick(name);
    setDraft("");
    setAdding(false);
  }

  return (
    <div className="glass-card flex flex-wrap items-center gap-2 px-5 py-3.5">
      <span className="mr-1 text-[13px] font-semibold text-ink">Speaker</span>
      {known.map((name) => {
        const active = name.toLowerCase() === speaker.toLowerCase();
        return (
          <button
            key={name}
            type="button"
            aria-pressed={active}
            onClick={() => onPick(name)}
            className={`h-8 rounded-lg border px-3 text-[13px] font-medium transition-colors ${
              active ? "border-brand-500 bg-brand-50 text-brand-700" : "border-line bg-surface text-muted hover:text-ink"
            }`}
          >
            {name}
          </button>
        );
      })}
      {showInput ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            autoFocus={adding}
            value={draft}
            maxLength={40}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Speaker's name, e.g. Bijay"
            aria-label="New speaker's name"
            className="h-8 w-52 rounded-lg border border-line bg-surface px-3 text-[13px] text-ink outline-none focus:border-brand-500"
          />
          <Button size="sm" variant="primary" type="submit" disabled={!draft.trim()}>
            Add
          </Button>
          {known.length ? (
            <Button size="sm" variant="ghost" type="button" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          ) : null}
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="h-8 px-2 text-[13px] font-medium text-brand-600 hover:text-brand-700"
        >
          + New speaker
        </button>
      )}
      <p className="basis-full text-[12px] text-muted">
        One person per set. A training run uses one speaker&apos;s clips, so never mix two voices under one name.
      </p>
    </div>
  );
}

// --- progress ----------------------------------------------------------------

function Progress({
  summary,
  language,
  onPick,
}: {
  summary: TrainingSummary[];
  language: TrainingLanguage;
  onPick: (l: TrainingLanguage) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {LANGS.map((l) => {
        const s = summary.find((x) => x.language === l.code) ?? { clips: 0, seconds: 0 };
        const minutes = s.seconds / 60;
        const active = l.code === language;
        return (
          <button
            key={l.code}
            type="button"
            onClick={() => onPick(l.code)}
            aria-pressed={active}
            className={`glass-card px-5 py-4 text-left transition-colors ${
              active ? "border-brand-500 ring-2 ring-brand-500/20" : ""
            }`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[14px] font-semibold text-ink">{l.name}</span>
              <span className="text-[12px] text-muted">
                {s.clips} clip{s.clips === 1 ? "" : "s"}
              </span>
            </div>
            <div className="mt-3">
              <ProgressBar value={minutes} max={TARGET_MINUTES} label={`${l.name} progress`} />
            </div>
            <p className="mt-2 text-[12.5px] text-muted">
              {minutes.toFixed(1)} of {TARGET_MINUTES} minutes
              {minutes >= TARGET_MINUTES ? " — enough for a first training run" : ""}
            </p>
          </button>
        );
      })}
    </div>
  );
}

// --- add -------------------------------------------------------------------

function AddClipCard({
  language,
  speaker,
  recordedPrompts,
  disabled,
  onSaved,
}: {
  language: TrainingLanguage;
  speaker: string;
  recordedPrompts: Set<string>;
  disabled: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const [mode, setMode] = useState<"prompt" | "free">("prompt");
  const [prompt, setPrompt] = useState<TrainingPrompt | null>(() =>
    nextPrompt(language, recordedPrompts)
  );
  const [text, setText] = useState(prompt?.text ?? "");
  // Starts as the sentence's reading note, so a clip can be saved straight
  // away; anything the speaker types instead is kept between clips.
  const [description, setDescription] = useState(prompt?.note ?? "");
  const [capture, setCapture] = useState<Capture | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const media = useRef<{ recorder: MediaRecorder; stream: MediaStream; ctx: AudioContext; raf: number } | null>(null);
  const chunks = useRef<BlobPart[]>([]);
  const startedAt = useRef(0);

  useEffect(() => () => stopTracks(), []);
  useEffect(() => () => (capture ? URL.revokeObjectURL(capture.url) : undefined), [capture]);

  const done = recordedPrompts.size;
  const total = TRAINING_PROMPTS[language].length;

  function stopTracks() {
    const m = media.current;
    if (!m) return;
    cancelAnimationFrame(m.raf);
    if (m.recorder.state !== "inactive") m.recorder.stop();
    m.stream.getTracks().forEach((t) => t.stop());
    void m.ctx.close();
    media.current = null;
  }

  async function process(blob: Blob) {
    setPreparing(true);
    try {
      const decoded = await to24k(await decodeAudioBlob(blob));
      const raw = analyzeClip(decoded.samples, decoded.sampleRate);
      const trimmed = trimToSpeech(decoded.samples, decoded.sampleRate, raw);
      const pcm = { samples: trimmed, sampleRate: decoded.sampleRate };
      const metrics = analyzeClip(pcm.samples, pcm.sampleRate);
      setCapture({
        pcm,
        metrics,
        clipIssues: checkClip(metrics),
        url: URL.createObjectURL(encodeWavPcm16(pcm)),
      });
    } catch {
      toast("Couldn't read that audio. Try recording again, or a WAV, MP3 or M4A file.", "error");
    } finally {
      setPreparing(false);
    }
  }

  async function startRecording() {
    try {
      // Raw input: echo cancellation, noise suppression and automatic gain
      // all change the voice, and the model would learn the processing.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const recorder = new MediaRecorder(stream);
      chunks.current = [];
      recorder.ondataavailable = (e) => chunks.current.push(e.data);
      recorder.onstop = () => void process(new Blob(chunks.current, { type: recorder.mimeType }));
      recorder.start();
      startedAt.current = performance.now();
      setCapture(null);

      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const secs = (performance.now() - startedAt.current) / 1000;
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        setElapsed(secs);
        // A little over the limit, so trimming the silence can bring it back in.
        if (secs > MAX_CLIP_SEC + 2) {
          stopRecording();
          return;
        }
        if (media.current) media.current.raf = requestAnimationFrame(tick);
      };
      media.current = { recorder, stream, ctx, raf: requestAnimationFrame(tick) };
      setRecording(true);
    } catch {
      toast("Microphone access was denied. Allow it in the browser, or upload a file.", "error");
    }
  }

  function stopRecording() {
    stopTracks();
    setRecording(false);
    setLevel(0);
  }

  function goTo(p: TrainingPrompt | null) {
    // Follow the reading note from sentence to sentence, unless the speaker
    // has written a description of their own.
    setDescription((d) => (!d.trim() || d === prompt?.note ? p?.note ?? "" : d));
    setPrompt(p);
    setText(p?.text ?? "");
    setCapture(null);
  }

  const textIssues = capture
    ? checkTranscript(text, capture.metrics.speechEndSec - capture.metrics.speechStartSec, language)
    : [];
  const issues = capture ? [...capture.clipIssues, ...textIssues] : [];
  const canSave = Boolean(capture && speaker && !blocks(issues) && !saving && !disabled);

  async function save() {
    if (!capture) return;
    setSaving(true);
    try {
      const form = new FormData();
      form.append("audio", encodeWavPcm16(capture.pcm), "clip.wav");
      form.append("language", language);
      form.append("speaker", speaker);
      form.append("text", text);
      if (description.trim()) form.append("description", description);
      form.append("source", mode);
      if (mode === "prompt" && prompt) form.append("promptId", prompt.id);
      form.append(
        "checks",
        JSON.stringify({
          peakDb: Math.round(capture.metrics.peakDb * 10) / 10,
          speechDb: Math.round(capture.metrics.speechDb * 10) / 10,
          longestPauseSec: Math.round(capture.metrics.longestPauseSec * 10) / 10,
          warnings: issues.filter((i) => i.level === "warn").map((i) => i.code),
        })
      );
      const res = await fetch("/api/admin/training", { method: "POST", body: form });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast(json.error ?? "Couldn't save the clip.", "error");
        return;
      }
      toast("Clip saved.", "success");
      if (mode === "prompt" && prompt) {
        goTo(nextPrompt(language, new Set([...recordedPrompts, prompt.id]), prompt.id));
      } else {
        setText("");
        setCapture(null);
      }
      if (fileInput.current) fileInput.current.value = "";
      await onSaved();
    } catch {
      toast("Couldn't reach the server.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="glass-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface2 px-5 py-3.5">
        <div>
          <h2 className="text-[13px] font-semibold text-ink">
            Add a clip{speaker ? ` for ${speaker}` : ""}
          </h2>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Quiet room, same mic each time, normal speaking voice. 3–{MAX_CLIP_SEC} seconds per clip.
          </p>
        </div>
        <div className="inline-flex rounded-xl border border-line bg-surface p-0.5" role="tablist">
          {(["prompt", "free"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => {
                setMode(m);
                setCapture(null);
                setText(m === "prompt" ? prompt?.text ?? "" : "");
              }}
              className={`h-8 rounded-lg px-3 text-[12.5px] font-medium transition-colors ${
                mode === m ? "bg-brand-600 text-white" : "text-muted hover:text-ink"
              }`}
            >
              {m === "prompt" ? "Read a sentence" : "Free recording"}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4 px-5 py-4">
        {mode === "prompt" ? (
          prompt ? (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[12px] text-faint">
                <span>
                  Sentence {prompt.id} · {done} of {total} recorded
                </span>
                <button
                  type="button"
                  className="font-medium text-brand-600 hover:text-brand-700"
                  onClick={() => goTo(nextPrompt(language, recordedPrompts, prompt.id))}
                  disabled={recording}
                >
                  Skip
                </button>
              </div>
              <p
                lang={language}
                className="rounded-xl border border-line bg-surface px-4 py-4 text-[19px] leading-relaxed text-ink"
              >
                {prompt.text}
              </p>
              {prompt.note ? (
                <p className="mt-1.5 text-[12.5px] text-muted">
                  <span className="font-medium text-ink">How to read: </span>
                  {prompt.note}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="rounded-xl border border-line bg-surface px-4 py-4 text-[13px] text-muted">
              Every built-in {language === "ne" ? "Nepali" : "English"} sentence is recorded. Switch to
              free recording to keep adding your own.
            </p>
          )
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          {recording ? (
            <Button variant="danger" onClick={stopRecording}>
              <span className="h-2 w-2 rounded-sm bg-danger" /> Stop · {elapsed.toFixed(1)}s
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void startRecording()}
              disabled={disabled || preparing || saving || (mode === "prompt" && !prompt)}
            >
              <IconMic className="h-4 w-4" /> {capture ? "Record again" : "Record"}
            </Button>
          )}
          {mode === "free" ? (
            <>
              <input
                ref={fileInput}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void process(f);
                }}
              />
              <Button onClick={() => fileInput.current?.click()} disabled={recording || preparing || disabled}>
                <IconUpload className="h-4 w-4" /> Upload a file
              </Button>
            </>
          ) : null}
          {recording ? (
            <div className="h-2 w-40 overflow-hidden rounded-full bg-surface3" aria-label="Input level">
              <div className="h-full rounded-full bg-live transition-[width] duration-75" style={{ width: `${level * 100}%` }} />
            </div>
          ) : null}
          {preparing ? <span className="text-[12.5px] text-muted">Checking the clip…</span> : null}
        </div>

        {capture ? (
          <div className="space-y-3 rounded-xl border border-line bg-surface2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <audio src={capture.url} controls className="h-9 w-full max-w-sm" />
              <span className="text-[12.5px] text-muted">
                {capture.metrics.durationSec.toFixed(1)}s · speech {capture.metrics.speechDb.toFixed(0)} dBFS · peak{" "}
                {capture.metrics.peakDb.toFixed(1)} dBFS
              </span>
            </div>
            {issues.length ? (
              <ul className="space-y-1">
                {issues.map((i) => (
                  <li
                    key={i.code}
                    className={`flex gap-2 text-[12.5px] ${i.level === "block" ? "text-danger" : "text-live"}`}
                  >
                    <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {i.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 text-[12.5px] text-audio">
                <IconCheck className="h-3.5 w-3.5" /> Clean clip.
              </p>
            )}
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-ink" htmlFor="vf-train-text">
              Transcript <span className="font-normal text-muted">— exactly what is said</span>
            </label>
            <Textarea
              id="vf-train-text"
              lang={language}
              rows={3}
              value={text}
              maxLength={1000}
              placeholder={language === "ne" ? "बोलिएका शब्दहरू जस्ताको तस्तै लेख्नुहोस्" : "Type the words exactly as spoken"}
              onChange={(e) => setText(e.target.value)}
            />
            <p className="mt-1 text-[11.5px] text-faint">
              {mode === "prompt"
                ? "Filled in from the sentence. Edit only if you read it differently."
                : "Word for word, numbers written as spoken. This is what the model learns from."}
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-ink" htmlFor="vf-train-desc">
              Description <span className="font-normal text-muted">— optional notes</span>
            </label>
            <Textarea
              id="vf-train-desc"
              rows={3}
              value={description}
              maxLength={500}
              placeholder="e.g. calm news-reading tone · home office · USB mic"
              onChange={(e) => setDescription(e.target.value)}
            />
            <p className="mt-1 text-[11.5px] text-faint">
              Filled in with how to read the sentence; change it if you like. Kept with the clip, never read as speech.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3">
          {capture && !speaker ? (
            <span className="text-[12.5px] text-live">Add a speaker above before saving.</span>
          ) : null}
          <Button variant="primary" onClick={() => void save()} disabled={!canSave}>
            <IconCheck className="h-4 w-4" /> {saving ? "Saving…" : "Save clip"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- voice reference ---------------------------------------------------------

/**
 * Turn the best clips into the reference a cloned voice is made from.
 *
 * A cloned voice copies its style from the first 6 seconds of one reference
 * clip, and nothing else. These recordings are the cleanest audio of the
 * speaker there is, so building the reference from them is how they shape
 * the voice before any training run exists. Clips with level warnings are
 * left out when there are enough without.
 */
function ReferenceCard({
  language,
  speaker,
  samples,
}: {
  language: TrainingLanguage;
  speaker: string;
  samples: TrainingSample[];
}) {
  const langName = language === "ne" ? "Nepali" : "English";
  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [built, setBuilt] = useState<{ blob: Blob; url: string; used: TrainingSample[]; seconds: number } | null>(null);
  const [name, setName] = useState(`${speaker || "My voice"} - ${langName} (from training)`);

  useEffect(() => () => (built ? URL.revokeObjectURL(built.url) : undefined), [built]);

  async function build() {
    setBuilding(true);
    try {
      // Oldest first, so the reference stays the same as clips are added.
      const ordered = [...samples].reverse();
      const pcm = await Promise.all(
        ordered.map(async (s) => (await to24k(await decodeAudioBlob(await (await fetch(s.url)).blob()))).samples)
      );
      const clean = ordered.map((s, i) => (s.checks?.warnings?.length ? -1 : i)).filter((i) => i >= 0);
      // The first 6 seconds from clean clips when there are enough; the
      // rest, which only sets the sound of the voice, from any clip.
      const r =
        buildReference(pcm, TRAINING_SAMPLE_RATE, clean) ?? buildReference(pcm, TRAINING_SAMPLE_RATE);
      if (!r) {
        toast("Not enough speech yet — record a few more sentences, then try again.", "error");
        return;
      }
      const blob = encodeWavPcm16({ samples: r.samples, sampleRate: TRAINING_SAMPLE_RATE });
      setBuilt({ blob, url: URL.createObjectURL(blob), used: r.used.map((i) => ordered[i]), seconds: r.durationSec });
    } catch {
      toast("Couldn't read the clips.", "error");
    } finally {
      setBuilding(false);
    }
  }

  async function save() {
    if (!built) return;
    setSaving(true);
    try {
      const form = new FormData();
      form.append("audio", built.blob, "reference.wav");
      form.append("name", name.trim());
      form.append("language", language);
      form.append("transcript", built.used.map((s) => s.text).join(" "));
      const res = await fetch("/api/admin/voices", { method: "POST", body: form });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast(json.error ?? "Couldn't save the voice.", "error");
        return;
      }
      toast(`"${name.trim()}" added to Voices. Pick it in the studio, or use its id in n8n.`, "success");
      setBuilt(null);
    } catch {
      toast("Couldn't reach the server.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="glass-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface2 px-5 py-3.5">
        <div>
          <h2 className="text-[13px] font-semibold text-ink">Use these recordings as a voice</h2>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Builds a clean 10-second reference from your best clips and adds it to Voices. The cloned voice takes its
            pace and style from it.
          </p>
        </div>
        <Button onClick={() => void build()} disabled={building || saving || samples.length < 2}>
          <IconWave className="h-4 w-4" /> {building ? "Building…" : built ? "Build again" : "Build reference"}
        </Button>
      </div>
      {built ? (
        <div className="space-y-3 px-5 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <audio src={built.url} controls className="h-9 w-full max-w-sm" />
            <span className="text-[12.5px] text-muted">
              {built.seconds.toFixed(1)}s · sentences {built.used.map((s) => s.promptId ?? "free").join(", ")}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              aria-label="Voice name"
              className="h-9 w-72 rounded-lg border border-line bg-surface px-3 text-[13px] text-ink outline-none focus:border-brand-500"
            />
            <Button variant="primary" onClick={() => void save()} disabled={saving || !name.trim()}>
              <IconCheck className="h-4 w-4" /> {saving ? "Saving…" : "Save as voice"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- list ------------------------------------------------------------------

function ClipList({
  language,
  speaker,
  samples,
  busy,
  onDelete,
  onSaveEdit,
}: {
  language: TrainingLanguage;
  speaker: string;
  samples: TrainingSample[];
  busy: string | null;
  onDelete: (s: TrainingSample) => void;
  onSaveEdit: (s: TrainingSample, text: string, description: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftDesc, setDraftDesc] = useState("");
  const total = samples.reduce((n, s) => n + s.durationSec, 0);
  const who = speaker ? `&speaker=${encodeURIComponent(speaker)}` : "";

  return (
    <div className="glass-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface2 px-5 py-3.5">
        <div>
          <h2 className="text-[13px] font-semibold text-ink">
            Clips · {samples.length} · {formatDuration(total)}
          </h2>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {speaker ? `${speaker}'s` : "The"} dataset a training run will use. Newest first.
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={`/api/admin/training/manifest?language=${language}&format=txt${who}`}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] text-ink hover:border-lineStrong ${
              samples.length ? "" : "pointer-events-none opacity-40"
            }`}
          >
            <IconDownload className="h-3.5 w-3.5" /> Dataset (.txt)
          </a>
          <a
            href={`/api/admin/training/manifest?language=${language}&format=json${who}`}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] text-ink hover:border-lineStrong ${
              samples.length ? "" : "pointer-events-none opacity-40"
            }`}
          >
            <IconDownload className="h-3.5 w-3.5" /> JSON
          </a>
        </div>
      </div>

      {samples.length === 0 ? (
        <p className="px-5 py-8 text-center text-[13px] text-muted">
          No {language === "ne" ? "Nepali" : "English"} clips{speaker ? ` for ${speaker}` : ""} yet. Record the first
          sentence above.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {samples.map((s) => (
            <li key={s.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center">
              <audio src={s.url} controls preload="none" className="h-8 w-full shrink-0 sm:w-56" />
              <div className="min-w-0 flex-1">
                {editing === s.id ? (
                  <div className="flex flex-col gap-2">
                    <Textarea
                      lang={s.language}
                      rows={2}
                      value={draft}
                      aria-label="Transcript"
                      onChange={(e) => setDraft(e.target.value)}
                    />
                    <Textarea
                      rows={2}
                      value={draftDesc}
                      maxLength={500}
                      aria-label="Description"
                      placeholder="Description (optional)"
                      onChange={(e) => setDraftDesc(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy !== null}
                        onClick={async () => {
                          if (await onSaveEdit(s, draft, draftDesc)) setEditing(null);
                        }}
                      >
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p lang={s.language} className="text-[14px] leading-relaxed text-ink">
                      {s.text}
                    </p>
                    {s.description ? (
                      <p className="mt-0.5 whitespace-pre-line text-[12.5px] italic text-muted">{s.description}</p>
                    ) : null}
                  </>
                )}
                <p className="mt-0.5 text-[11.5px] text-faint">
                  {s.durationSec.toFixed(1)}s · {s.source === "prompt" ? `sentence ${s.promptId}` : "free"} ·{" "}
                  {new Date(s.createdAt).toLocaleDateString()}
                  {s.checks?.warnings?.length ? ` · ${s.checks.warnings.length} warning${s.checks.warnings.length === 1 ? "" : "s"}` : ""}
                </p>
              </div>
              {editing === s.id ? null : (
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Edit transcript and description"
                    onClick={() => {
                      setEditing(s.id);
                      setDraft(s.text);
                      setDraftDesc(s.description ?? "");
                    }}
                  >
                    <IconEdit className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Delete clip"
                    disabled={busy === `del-${s.id}`}
                    onClick={() => onDelete(s)}
                  >
                    <IconTrash className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
