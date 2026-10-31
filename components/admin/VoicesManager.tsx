"use client";

import { SkeletonCard } from "@/components/ui/Kit";
import { confirmAction } from "@/lib/confirm";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeAudioBlob, encodeWavPcm16, formatDuration } from "@/lib/audio";
import { LANGUAGES, SAMPLE_IDEAL_MAX_SEC, SAMPLE_IDEAL_MIN_SEC } from "@/lib/config";
import { toast } from "@/lib/toast";
import type { LibraryVoiceView, VoiceRefSlot } from "@/lib/types";
import { arrangeRecording, checkReference, speechBounds } from "@/lib/voiceReference";
import { looksNepali, scriptGuide, scriptText } from "@/lib/voiceScripts";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import {
  IconAlert,
  IconCheck,
  IconLink,
  IconMic,
  IconRefresh,
  IconTrash,
  IconUpload,
} from "@/components/ui/Icons";

interface Payload {
  voices: LibraryVoiceView[];
  storageReady: boolean;
  hint: string | null;
}

function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

export function VoicesManager() {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/voices", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as Payload);
    } catch {
      toast("Couldn't load the voice library.", "error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(url: string, init: RequestInit, label: string, okMessage?: string) {
    setBusy(label);
    try {
      const res = await fetch(url, init);
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast(json.error ?? "That didn't work.", "error");
        return false;
      }
      if (okMessage) toast(okMessage, "success");
      await load();
      return true;
    } catch {
      toast("Couldn't reach the server.", "error");
      return false;
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
      {/*
        Driven by the hint, not by storageReady. storageReady only reports
        whether credentials exist, so a configured-but-failing Redis — a blown
        quota, an outage — rendered the ordinary empty state and looked like
        "you have no voices". The hint is set in both cases.
      */}
      {data.hint ? (
        <div className="flex gap-3 rounded-2xl border border-live/30 bg-liveSoft px-5 py-4">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-live" />
          <p className="text-[13px] leading-relaxed text-ink">
            <strong>Storage isn&apos;t ready.</strong> {data.hint} Clips live in Blob and their
            details in Redis, so both are needed before a voice can be saved.
          </p>
        </div>
      ) : null}

      <AddVoiceCard disabled={!data.storageReady || busy !== null} onAdded={load} />

      {data.voices.length === 0 ? (
        <div className="glass-card px-5 py-10 text-center">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-brand-50 text-brand-600">
            <IconMic className="h-5 w-5" />
          </span>
          <p className="mt-3 text-[14px] font-medium text-ink">No voices yet</p>
          <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-muted">
            Add one {SAMPLE_IDEAL_MIN_SEC}–{SAMPLE_IDEAL_MAX_SEC} second clip of clean speech.
            It&apos;s stored once here and cached onto whichever GPU backend is running — including
            after a Colab restart.
          </p>
        </div>
      ) : (
        data.voices.map((v) => (
          <VoiceRow
            key={v.id}
            voice={v}
            others={data.voices.filter((o) => o.id !== v.id)}
            busy={busy}
            onLinkRef={(slot, refId) =>
              void act(
                `/api/admin/voices/${v.id}`,
                {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ refs: { [slot]: refId } }),
                },
                `ref-${v.id}-${slot}`,
                refId ? "Linked." : "Unlinked."
              )
            }
            onSetDefault={() =>
              void act(
                `/api/admin/voices/${v.id}`,
                {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ makeDefault: true }),
                },
                `default-${v.id}`
              )
            }
            onRename={(name) =>
              void act(
                `/api/admin/voices/${v.id}`,
                {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name }),
                },
                `rename-${v.id}`
              )
            }
            onLanguage={(language) =>
              void act(
                `/api/admin/voices/${v.id}`,
                {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ language }),
                },
                `language-${v.id}`,
                "Language updated."
              )
            }
            onSync={() =>
              void act(
                `/api/admin/voices/${v.id}/sync`,
                { method: "POST" },
                `sync-${v.id}`,
                "Cached on the active backend."
              )
            }
            onDelete={() => {
              void confirmAction({
                title: `Delete "${v.name}"?`,
                body: "The reference clip is removed from storage. This can't be undone.",
                confirmLabel: "Delete voice",
                danger: true,
              }).then((ok) => {
                if (ok) void act(`/api/admin/voices/${v.id}`, { method: "DELETE" }, `delete-${v.id}`);
              });
            }}
          />
        ))
      )}
    </div>
  );
}

// --- add ------------------------------------------------------------------

const LANGUAGE_KEY = "vf:voice-language";
/**
 * Recording stops by itself here. The sound of the voice is taken from its
 * first 10 seconds, and the speaker's pace from the whole clip.
 */
const MAX_RECORD_SEC = 45;

interface PreparedClip {
  /** What is saved: laid out for the model when that was possible. */
  blob: Blob;
  durationSec: number;
  /** The clip exactly as recorded or uploaded, lead-in silence trimmed. */
  original: { blob: Blob; durationSec: number; warnings: string[] };
  /** Set when the clip was laid out: where the first part ends. */
  arranged: { styleEndsAt: number; restStartsAt: number } | null;
  fileName: string;
  trimmedSec: number;
  warnings: string[];
}

function AddVoiceCard({ disabled, onAdded }: { disabled: boolean; onAdded: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<"record" | "upload">("record");
  const [clip, setClip] = useState<PreparedClip | null>(null);
  const [useOriginal, setUseOriginal] = useState(false);
  const [name, setName] = useState("");
  const [language, setLanguageState] = useState("en");
  const [languageNote, setLanguageNote] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [scriptIdx, setScriptIdx] = useState(0);
  const [ownWords, setOwnWords] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const media = useRef<{ recorder: MediaRecorder; stream: MediaStream; ctx: AudioContext; raf: number } | null>(null);
  const chunks = useRef<BlobPart[]>([]);
  const startedAt = useRef(0);

  const guide = scriptGuide(language);
  const script = guide.scripts.length ? guide.scripts[scriptIdx % guide.scripts.length] : null;
  const readingScript = source === "record" && !ownWords && script !== null;
  const chosen = clip ? (useOriginal ? clip.original : clip) : null;
  const warnings = clip ? (useOriginal ? clip.original.warnings : clip.warnings) : [];

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LANGUAGE_KEY);
      if (saved && LANGUAGES.some((l) => l.code === saved)) setLanguageState(saved);
    } catch {
      // No storage: English it is.
    }
  }, []);

  useEffect(() => () => stopTracks(), []);

  // The transcript follows the script being read, so the voice is saved with
  // the right words without typing them.
  useEffect(() => {
    if (readingScript && script) setTranscript(scriptText(script));
  }, [readingScript, script]);

  const previewUrl = useMemo(() => (chosen ? URL.createObjectURL(chosen.blob) : null), [chosen]);
  useEffect(() => () => (previewUrl ? URL.revokeObjectURL(previewUrl) : undefined), [previewUrl]);

  function setLanguage(code: string) {
    setLanguageState(code);
    setLanguageNote(false);
    setScriptIdx(0);
    try {
      localStorage.setItem(LANGUAGE_KEY, code);
    } catch {
      // Remembering is a convenience.
    }
  }

  function changeTranscript(text: string) {
    setTranscript(text);
    // Not while reading a script: switching would swap the script and its words.
    if (!readingScript && looksNepali(text) && language !== "ne" && language !== "hi") {
      setLanguage("ne");
      setLanguageNote(true);
    }
  }

  /**
   * Decode whatever was recorded or picked and re-encode to 16-bit PCM WAV
   * here, in the browser. The backends read clips with soundfile, whose MP3
   * support depends on the libsndfile build on the GPU host — so we never
   * send one. The clip is also laid out the way the model reads it: first
   * line, quiet across the 6-second mark, the rest (lib/voiceReference.ts).
   */
  async function prepare(blob: Blob, fileName: string) {
    setPreparing(true);
    try {
      const decoded = await decodeAudioBlob(blob);
      const sr = decoded.sampleRate;
      // Silence before the first word is copied into every generated clip,
      // so it is cut here either way.
      const lead = speechBounds(decoded.samples, sr)?.start ?? 0;
      const cut = lead > 0.1 ? Math.floor((lead - 0.05) * sr) : 0;
      const trimmed = decoded.samples.slice(cut);
      const original = {
        blob: encodeWavPcm16({ samples: trimmed, sampleRate: sr }),
        durationSec: trimmed.length / sr,
        warnings: checkReference(trimmed, sr).warnings,
      };
      const arranged = arrangeRecording(decoded.samples, sr);
      const samples = arranged?.samples ?? trimmed;
      setClip({
        blob: arranged ? encodeWavPcm16({ samples, sampleRate: sr }) : original.blob,
        durationSec: samples.length / sr,
        original,
        arranged: arranged ? { styleEndsAt: arranged.styleEndsAt, restStartsAt: arranged.restStartsAt } : null,
        fileName,
        trimmedSec: cut / sr,
        warnings: arranged ? checkReference(samples, sr).warnings : original.warnings,
      });
      setUseOriginal(false);
    } catch {
      toast("Couldn't read that audio. Try recording again, or a WAV, MP3 or M4A file.", "error");
    } finally {
      setPreparing(false);
    }
  }

  function stopTracks() {
    const m = media.current;
    if (!m) return;
    cancelAnimationFrame(m.raf);
    if (m.recorder.state !== "inactive") m.recorder.stop();
    m.stream.getTracks().forEach((t) => t.stop());
    void m.ctx.close();
    media.current = null;
  }

  async function startRecording() {
    try {
      // Raw input: echo cancellation, noise suppression and automatic gain
      // all change the voice, and the clone would copy the processing.
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
      recorder.onstop = () => void prepare(new Blob(chunks.current, { type: recorder.mimeType }), "Recording");
      recorder.start();
      startedAt.current = performance.now();
      setClip(null);

      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const secs = (performance.now() - startedAt.current) / 1000;
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        setElapsed(secs);
        if (secs > MAX_RECORD_SEC) {
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

  async function submit() {
    if (!chosen) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("audio", chosen.blob, "reference.wav");
      form.append("name", name.trim());
      form.append("language", language);
      form.append("transcript", transcript.trim());

      const res = await fetch("/api/admin/voices", { method: "POST", body: form });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast(json.error ?? "Upload failed.", "error");
        return;
      }
      toast(`"${name.trim()}" added to the library.`, "success");
      setClip(null);
      setName("");
      setTranscript(readingScript && script ? scriptText(script) : "");
      if (fileInput.current) fileInput.current.value = "";
      onAdded();
    } catch {
      toast("Couldn't reach the server.", "error");
    } finally {
      setUploading(false);
    }
  }

  const tooShort = chosen !== null && chosen.durationSec < 4;
  const canSubmit = Boolean(chosen && name.trim() && !tooShort && !uploading && !recording && !disabled);

  return (
    <div className="glass-card overflow-hidden">
      <div className="border-b border-line bg-surface2 px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">Add a voice</h2>
        <p className="mt-0.5 text-[12.5px] text-muted">
          Clone your own voice, or one you have explicit permission to clone.
        </p>
      </div>

      <div className="space-y-4 px-5 py-4">
        {/* Language first: it decides what there is to read. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-muted" htmlFor="vf-lang">
              Language
            </label>
            <Select id="vf-lang" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </Select>
            {languageNote ? (
              <p className="mt-1.5 text-[12px] text-muted">Set to Nepali because the transcript is in Nepali.</p>
            ) : null}
          </div>
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-muted" htmlFor="vf-name">
              Name
            </label>
            <Input
              id="vf-name"
              value={name}
              maxLength={80}
              placeholder={language === "ne" ? "My Nepali voice" : "My narration voice"}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12.5px] font-medium text-muted">Reference clip</span>
            <div className="inline-flex rounded-xl border border-line bg-surface p-0.5" role="tablist">
              {(["record", "upload"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={source === m}
                  disabled={recording || preparing}
                  onClick={() => {
                    setSource(m);
                    setClip(null);
                    if (m === "upload") setTranscript("");
                  }}
                  className={`h-8 rounded-lg px-3 text-[12.5px] font-medium transition-colors ${
                    source === m ? "bg-brand-600 text-white" : "text-muted hover:text-ink"
                  }`}
                >
                  {m === "record" ? "Record" : "Upload a file"}
                </button>
              ))}
            </div>
          </div>

          {source === "record" ? (
            <div className="space-y-3">
              <p lang={language} className="text-[12.5px] leading-relaxed text-muted">
                {readingScript ? guide.howTo : guide.ownText}
              </p>
              {readingScript && script ? (
                <div lang={language} className="rounded-xl border border-line bg-surface px-4 py-4">
                  <p className="text-[18px] leading-relaxed text-ink">{script.first}</p>
                  <p className="my-2 flex items-center gap-2 text-[12px] font-medium text-brand-600">
                    <span className="h-px flex-1 bg-brand-100" />
                    {guide.pause}
                    <span className="h-px flex-1 bg-brand-100" />
                  </p>
                  <p className="text-[18px] leading-relaxed text-ink">{script.rest}</p>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                {recording ? (
                  <Button variant="danger" size="sm" onClick={stopRecording}>
                    <span className="h-2 w-2 rounded-sm bg-danger" /> Stop · {elapsed.toFixed(1)}s
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={disabled || preparing || uploading}
                    onClick={() => void startRecording()}
                  >
                    <IconMic className="h-3.5 w-3.5" /> {clip ? "Record again" : "Record"}
                  </Button>
                )}
                {recording ? (
                  <div className="h-2 w-40 overflow-hidden rounded-full bg-surface3" aria-label="Input level">
                    <div
                      className="h-full rounded-full bg-live transition-[width] duration-75"
                      style={{ width: `${level * 100}%` }}
                    />
                  </div>
                ) : (
                  <>
                    {guide.scripts.length > 1 && !ownWords ? (
                      <Button size="sm" onClick={() => setScriptIdx((i) => i + 1)} disabled={preparing}>
                        <IconRefresh className="h-3.5 w-3.5" /> Another script
                      </Button>
                    ) : null}
                    {guide.scripts.length ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={preparing}
                        onClick={() => {
                          setOwnWords((o) => !o);
                          setClip(null);
                          if (!ownWords) setTranscript("");
                        }}
                      >
                        {ownWords ? "Read the suggested script" : "Read my own words"}
                      </Button>
                    ) : null}
                  </>
                )}
                {preparing ? <span className="text-[12.5px] text-muted">Checking the clip…</span> : null}
              </div>
            </div>
          ) : (
            <div>
              {/* The file input is its own control with a visible button — never
                  wrapped in a label that also holds other inputs, which silently
                  swallows the click. */}
              <input
                ref={fileInput}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  void prepare(f, f.name);
                  if (!name) setName(f.name.replace(/\.[^.]+$/, "").slice(0, 60));
                }}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" disabled={preparing || uploading} onClick={() => fileInput.current?.click()}>
                  <IconUpload className="h-3.5 w-3.5" />
                  {preparing ? "Reading…" : "Choose file"}
                </Button>
                {clip ? (
                  <span className="text-[12.5px] text-muted">{clip.fileName}</span>
                ) : (
                  <span className="text-[12.5px] text-faint">
                    {SAMPLE_IDEAL_MIN_SEC}–{SAMPLE_IDEAL_MAX_SEC}s of clean speech, no music
                  </span>
                )}
              </div>
            </div>
          )}

          {chosen && previewUrl ? (
            <div className="mt-3 space-y-2 rounded-xl border border-line bg-surface2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <audio src={previewUrl} controls className="h-9 w-full max-w-sm" />
                <span className="text-[12.5px] text-muted">{formatDuration(chosen.durationSec)}</span>
              </div>
              {clip?.arranged ? (
                <label className="flex items-start gap-2 text-[12px] text-muted">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={!useOriginal}
                    onChange={(e) => setUseOriginal(!e.target.checked)}
                  />
                  <span>
                    Laid out for the model: the first part ends at {clip.arranged.styleEndsAt.toFixed(1)}s and the
                    rest starts at {clip.arranged.restStartsAt.toFixed(1)}s, so every generated clip starts cleanly.
                    Untick to keep it exactly as recorded.
                  </span>
                </label>
              ) : clip && clip.trimmedSec > 0 ? (
                <p className="text-[12px] text-muted">
                  Cut {clip.trimmedSec.toFixed(1)}s of silence from the start, so generated speech starts on time.
                </p>
              ) : null}
              {tooShort ? (
                <p className="text-[12px] text-live">That clip is under 4 seconds — too short to clone reliably.</p>
              ) : chosen.durationSec < 10 ? (
                <p className="text-[12px] text-live">
                  Under 10 seconds. The sound of the voice comes from the first 10, so a longer clip clones better.
                </p>
              ) : null}
              {warnings.map((w) => (
                <p key={w} className="flex gap-2 text-[12px] text-live">
                  <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {w}
                </p>
              ))}
            </div>
          ) : null}
        </div>

        <div>
          <label className="mb-1.5 block text-[12.5px] font-medium text-muted" htmlFor="vf-transcript">
            Transcript <span className="text-faint">— the exact words in the clip</span>
          </label>
          <Textarea
            id="vf-transcript"
            lang={language}
            rows={3}
            value={transcript}
            onChange={(e) => changeTranscript(e.target.value)}
            placeholder={guide.transcriptPlaceholder}
          />
          {readingScript ? (
            <p className="mt-1 text-[11.5px] text-faint">Filled in from the script. Edit it if you read something differently.</p>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-line bg-surface2 px-5 py-3">
        <p className="text-[12px] text-muted">Stored once. Cached onto any backend the first time it&apos;s used.</p>
        <Button variant="primary" size="sm" className="ml-auto" disabled={!canSubmit} onClick={() => void submit()}>
          {uploading ? "Saving…" : "Add voice"}
        </Button>
      </div>
    </div>
  );
}

// --- row ------------------------------------------------------------------

/** What each linked-voice slot is for, in the words the admin needs. */
const REF_SLOTS: { slot: VoiceRefSlot; label: string; hint: string }[] = [
  { slot: "en", label: "English words", hint: "You speaking English — voices English words in a mixed script" },
  { slot: "excited", label: "[excited]", hint: "You speaking with energy — hooks and quick wins" },
  { slot: "serious", label: "[serious]", hint: "You speaking firmly — warnings" },
  { slot: "calm", label: "[calm]", hint: "You explaining steps calmly" },
];

function VoiceRow({
  voice,
  others,
  onLinkRef,
  busy,
  onSetDefault,
  onRename,
  onLanguage,
  onSync,
  onDelete,
}: {
  voice: LibraryVoiceView;
  others: LibraryVoiceView[];
  onLinkRef: (slot: VoiceRefSlot, refId: string | null) => void;
  busy: string | null;
  onSetDefault: () => void;
  onRename: (name: string) => void;
  onLanguage: (language: string) => void;
  onSync: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(voice.name);
  const [copied, setCopied] = useState(false);
  const locked = busy !== null;

  return (
    <div className="glass-card overflow-hidden">
      <div className="flex flex-wrap items-start gap-4 px-5 py-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
          <IconMic className="h-5 w-5" />
        </span>

        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex gap-2">
              <Input
                autoFocus
                value={draft}
                maxLength={80}
                onChange={(e) => setDraft(e.target.value)}
                className="h-8 max-w-xs text-[13px]"
              />
              <Button
                size="sm"
                variant="primary"
                disabled={!draft.trim() || locked}
                onClick={() => {
                  onRename(draft.trim());
                  setEditing(false);
                }}
              >
                Save
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setDraft(voice.name);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-semibold text-ink">{voice.name}</h3>
              {voice.isDefault ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700">
                  <IconCheck className="h-3 w-3" />
                  default
                </span>
              ) : null}
            </div>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
            {/*
              Editable, not a label. A voice's language decides which
              synthesis profile it gets, so it is the one field you most need
              to change after the fact — and it was the one field only the
              Add form could set.
            */}
            <Select
              aria-label="Language"
              value={voice.language}
              disabled={locked}
              onChange={(e) => {
                if (e.target.value !== voice.language) onLanguage(e.target.value);
              }}
              className="h-7 w-auto py-0 text-[12px]"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
              {/* Keep an unrecognised stored code visible rather than
                  silently showing the first option instead. */}
              {LANGUAGES.some((l) => l.code === voice.language) ? null : (
                <option value={voice.language}>{languageName(voice.language)}</option>
              )}
            </Select>
            <span>{formatDuration(voice.durationSec)}</span>
            {/*
              This string is what every API caller sends as voice_id, so it is
              copied far more often than it is read. Leaving it as plain text
              meant selecting an id with a random tail by hand, into n8n.
            */}
            <button
              type="button"
              title="Copy this voice_id"
              onClick={() => {
                void navigator.clipboard.writeText(voice.id);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2 py-1 font-mono text-[11.5px] text-faint transition hover:border-brand-300 hover:text-ink"
            >
              {voice.id}
              {copied ? (
                <IconCheck className="h-3 w-3 text-brand-600" />
              ) : (
                <IconLink className="h-3 w-3" />
              )}
            </button>
            {copied ? (
              <span className="text-[11.5px] font-medium text-brand-600">Copied</span>
            ) : null}
          </div>

          {voice.transcript ? (
            <p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-muted">
              “{voice.transcript}”
            </p>
          ) : (
            <p className="mt-2 text-[12px] text-faint">
              No transcript — Qwen3 needs one, Chatterbox clones better with it.
            </p>
          )}

          <audio src={voice.audioUrl} controls preload="none" className="mt-3 h-9 w-full max-w-sm" />

          {/*
            Linked voices are only used by expressive narration
            (code_switch / prosody_tags). Each is another clip of the same
            person — Chatterbox copies the delivery of its reference, so a
            calm clip makes calm speech and an English clip makes English
            sound English.
          */}
          {others.length ? (
            <details className="mt-3 text-[12px] text-muted" open={Boolean(voice.refs)}>
              <summary className="cursor-pointer select-none font-medium text-ink">
                Linked voices{voice.refs ? ` (${Object.keys(voice.refs).length})` : ""}
              </summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {REF_SLOTS.map(({ slot, label, hint }) => (
                  <label key={slot} className="flex flex-col gap-1" title={hint}>
                    <span className="text-[11.5px] font-semibold text-faint">{label}</span>
                    <Select
                      aria-label={`${label} voice`}
                      value={voice.refs?.[slot] ?? ""}
                      disabled={locked}
                      onChange={(e) => onLinkRef(slot, e.target.value || null)}
                      className="h-7 py-0 text-[12px]"
                    >
                      <option value="">— use this voice —</option>
                      {others.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name} ({languageName(o.language)})
                        </option>
                      ))}
                    </Select>
                    <span className="text-[11px] text-faint">{hint}</span>
                  </label>
                ))}
              </div>
            </details>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {!voice.isDefault ? (
            <Button size="sm" disabled={locked} onClick={onSetDefault}>
              Set default
            </Button>
          ) : null}
          <Button size="sm" disabled={locked} onClick={() => setEditing(true)}>
            Rename
          </Button>
          <Button size="sm" disabled={locked} onClick={onSync}>
            <IconRefresh className="h-3.5 w-3.5" />
            {busy === `sync-${voice.id}` ? "Syncing…" : "Sync"}
          </Button>
          <button
            type="button"
            disabled={locked}
            onClick={onDelete}
            aria-label={`Delete ${voice.name}`}
            className="grid h-8 w-8 place-items-center rounded-lg text-faint transition-colors hover:bg-dangerSoft hover:text-danger disabled:opacity-40"
          >
            <IconTrash className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
