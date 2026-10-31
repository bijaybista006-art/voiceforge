"use client";

import { useEffect, useRef, useState } from "react";
import { decodeAudioBlob, encodeWavPcm16, trimAudio, type PcmAudio } from "@/lib/audio";
import { uploadLibraryVoice } from "@/lib/gateway";
import { SAMPLE_IDEAL_MAX_SEC, SAMPLE_IDEAL_MIN_SEC, SAMPLE_MIN_SEC } from "@/lib/config";
import { useApp } from "@/lib/store";
import { toast } from "@/lib/toast";
import { VoiceCard } from "./VoiceCard";
import { Waveform, type TrimRange } from "./Waveform";
import { Button } from "./ui/Button";
import { FieldLabel } from "./ui/Card";
import { IconAlert, IconMic, IconUpload } from "./ui/Icons";
import { Input, Textarea } from "./ui/Input";

interface RecorderState {
  recording: boolean;
  elapsedSec: number;
  level: number;
  clipped: boolean;
  noisy: boolean;
}

const INITIAL_REC: RecorderState = {
  recording: false,
  elapsedSec: 0,
  level: 0,
  clipped: false,
  noisy: false,
};

export function VoiceLab() {
  const voices = useApp((s) => s.voices);
  const noteNewVoice = useApp((s) => s.noteNewVoice);
  const storageHint = useApp((s) => s.storageHint);
  const language = useApp((s) => s.project.params.language);

  const [rec, setRec] = useState<RecorderState>(INITIAL_REC);
  const [pcm, setPcm] = useState<PcmAudio | null>(null);
  const [trim, setTrim] = useState<TrimRange>({ start: 0, end: 0 });
  const [transcript, setTranscript] = useState("");
  const [name, setName] = useState("My voice");
  const [saving, setSaving] = useState(false);

  const mediaRef = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    ctx: AudioContext;
    raf: number;
  } | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const clippedRef = useRef(false);
  const minRmsRef = useRef(1);
  const startedAtRef = useRef(0);

  useEffect(() => () => stopTracks(), []);

  function stopTracks() {
    const m = mediaRef.current;
    if (!m) return;
    cancelAnimationFrame(m.raf);
    if (m.recorder.state !== "inactive") m.recorder.stop();
    m.stream.getTracks().forEach((t) => t.stop());
    void m.ctx.close();
    mediaRef.current = null;
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, channelCount: 1 },
      });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);

      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      clippedRef.current = false;
      minRmsRef.current = 1;
      startedAtRef.current = performance.now();

      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        try {
          const decoded = await decodeAudioBlob(blob);
          setPcm(decoded);
          setTrim({ start: 0, end: decoded.samples.length / decoded.sampleRate });
        } catch {
          toast("Couldn't decode the recording. Try again or upload a file.", "error");
        }
      };
      recorder.start();

      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        let peak = 0;
        for (const v of buf) {
          sum += v * v;
          const a = Math.abs(v);
          if (a > peak) peak = a;
        }
        const rms = Math.sqrt(sum / buf.length);
        if (peak >= 0.98) clippedRef.current = true;
        if (rms < minRmsRef.current) minRmsRef.current = rms;
        setRec({
          recording: true,
          elapsedSec: (performance.now() - startedAtRef.current) / 1000,
          level: Math.min(1, rms * 3),
          clipped: clippedRef.current,
          noisy: minRmsRef.current > 0.02 && performance.now() - startedAtRef.current > 3000,
        });
        if (mediaRef.current) mediaRef.current.raf = requestAnimationFrame(tick);
      };

      mediaRef.current = { recorder, stream, ctx, raf: 0 };
      mediaRef.current.raf = requestAnimationFrame(tick);
      setRec({ ...INITIAL_REC, recording: true });
    } catch {
      toast("Microphone access was denied. Upload a file instead.", "error");
    }
  }

  function stopRecording() {
    stopTracks();
    setRec((r) => ({ ...r, recording: false, level: 0 }));
  }

  async function onFile(file: File) {
    try {
      const decoded = await decodeAudioBlob(file);
      setPcm(decoded);
      setTrim({ start: 0, end: decoded.samples.length / decoded.sampleRate });
      setRec(INITIAL_REC);
    } catch {
      toast(`Couldn't decode ${file.name}. Use .wav, .mp3 or .m4a.`, "error");
    }
  }

  /**
   * Saves to the central library, not to this browser and not to one GPU
   * session. There's no cloning step here any more: the backend caches the
   * clip the first time it's asked to speak with it, so a voice added while
   * every notebook is offline still works the moment one comes up.
   */
  async function onSave() {
    if (!pcm) return;
    setSaving(true);
    try {
      const trimmed = trimAudio(pcm, trim.start, trim.end);
      const wav = encodeWavPcm16(trimmed);
      const voice = await uploadLibraryVoice({
        wav,
        name: name.trim() || "My voice",
        language,
        transcript: transcript.trim(),
      });
      await noteNewVoice(voice);
      setPcm(null);
      setTranscript("");
      toast(`Voice "${voice.name}" saved to your library.`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save that voice.", "error");
    } finally {
      setSaving(false);
    }
  }

  const trimmedSec = pcm ? trim.end - trim.start : 0;
  const canSave =
    !!pcm && !saving && !storageHint && transcript.trim().length > 0 && trimmedSec >= SAMPLE_MIN_SEC;

  return (
    <div className="flex flex-col gap-4">
      {/* capture */}
      {!pcm && !rec.recording ? (
        <div className="rounded-xl border border-dashed border-line bg-surface2/40 px-4 py-6 text-center">
          <span className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-surface3 text-faint">
            <IconMic className="h-5 w-5" />
          </span>
          <p className="text-[13px] leading-relaxed text-muted">
            Record {SAMPLE_IDEAL_MIN_SEC}–{SAMPLE_IDEAL_MAX_SEC} seconds in a quiet room.
            <br />
            Read anything — a paragraph from an article works.
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button variant="primary" onClick={() => void startRecording()}>
              <IconMic className="h-4 w-4" /> Record
            </Button>
            <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-line bg-surface2 px-4 text-sm text-ink transition-colors hover:border-lineStrong hover:bg-surface3">
              <IconUpload className="h-4 w-4" /> Upload
              <input
                type="file"
                accept=".wav,.mp3,.m4a,audio/*"
                className="visually-hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>
      ) : null}

      {/* live recording */}
      {rec.recording ? (
        <div className="rounded-xl border border-live/40 bg-liveSoft p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="inline-flex items-center gap-2 text-[13px] font-medium text-live">
              <span aria-hidden className="h-2 w-2 animate-breathe rounded-full bg-live" />
              Recording
            </span>
            <span className="font-mono text-[13px] tabular-nums text-ink">
              {rec.elapsedSec.toFixed(1)}s
            </span>
          </div>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-surface3"
            role="meter"
            aria-label="Input level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(rec.level * 100)}
          >
            <div
              className={`h-full rounded-full transition-[width] duration-75 ${
                rec.clipped ? "bg-danger" : "bg-live"
              }`}
              style={{ width: `${rec.level * 100}%` }}
            />
          </div>
          {rec.clipped ? (
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-danger">
              <IconAlert className="h-3.5 w-3.5" /> Clipping — move back or lower the input gain.
            </p>
          ) : rec.noisy ? (
            <p className="mt-2 text-[12px] text-muted">
              The room sounds noisy — a quieter take clones better.
            </p>
          ) : null}
          <Button className="mt-4 w-full" onClick={stopRecording}>
            Stop recording
          </Button>
        </div>
      ) : null}

      {/* trim + clone */}
      {pcm ? (
        <div className="flex flex-col gap-4">
          <div>
            <FieldLabel>Trim silence</FieldLabel>
            <Waveform pcm={pcm} trim={trim} onTrimChange={setTrim} />
          </div>
          {trimmedSec < SAMPLE_MIN_SEC ? (
            <p className="text-[12px] text-live">
              Keep at least {SAMPLE_MIN_SEC}s — shorter samples clone poorly.
            </p>
          ) : null}
          <div>
            <FieldLabel>Voice name</FieldLabel>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </div>
          <div>
            <FieldLabel>
              Transcript <span className="text-live">· required</span>
            </FieldLabel>
            <Textarea
              rows={3}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="Type exactly what you said, word for word."
            />
            <p className="mt-1.5 text-[11.5px] leading-snug text-faint">
              This matters more than you&apos;d expect — the clone gets noticeably worse without it.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" className="flex-1" disabled={!canSave} onClick={() => void onSave()}>
              {saving ? "Saving…" : "Save voice"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setPcm(null);
                setRec(INITIAL_REC);
              }}
            >
              Discard
            </Button>
          </div>
          {storageHint ? (
            <p className="text-[12px] text-live">{storageHint}</p>
          ) : (
            <p className="text-[12px] text-faint">
              Saved once, then cached on whichever GPU is running — no re-cloning after a restart.
            </p>
          )}
        </div>
      ) : null}

      {/* saved voices */}
      {voices.length > 0 ? (
        <div>
          <FieldLabel>Voice library</FieldLabel>
          <div className="flex flex-col gap-2">
            {voices.map((v) => (
              <VoiceCard key={v.id} voice={v} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
