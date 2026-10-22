/**
 * Training clips: short recordings with the exact words spoken, collected per
 * language and per speaker for fine-tuning a voice later. Separate from the
 * voice library: nothing here appears in Voices or is used for TTS.
 *
 * A clip has three parts: the audio, the transcript (word for word — what the
 * model learns from) and an optional description (tone, room, mic — notes for
 * people, never fed to the model as speech).
 *
 * Each clip is a 24 kHz mono 16-bit WAV in the bucket under
 * training/<language>/<id>.wav, with its record at vf:sample:<id>. There is
 * deliberately no index list: lists are read by key prefix, because an index
 * rewritten by read-then-write loses entries when two saves overlap — the
 * bug that once stranded hundreds of scene uploads.
 *
 * Nothing here is swept. Training data is kept until it is deleted by hand.
 */

import {
  MAX_CLIP_SEC,
  MIN_CLIP_SEC,
  TRAINING_LANGUAGES,
  TRAINING_SAMPLE_RATE,
  isTrainingLanguage,
} from "@/lib/trainingChecks";
import type { TrainingSample, TrainingSummary } from "@/lib/types";
import { deleteBlob, isBlobConfigured, putBlob } from "./blob";
import { isRedisConfigured, kvDel, kvGet, kvScan, kvSet, redisFailure } from "./redis";
import { readWavMeta } from "./voices";

const KEY = (id: string) => `vf:sample:${id}`;
const PREFIX = "vf:sample:";

/** 20 s at 24 kHz mono 16-bit is under 1 MB; anything near this is wrong. */
export const MAX_SAMPLE_BYTES = 3 * 1024 * 1024;

export class TrainingError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "TrainingError";
    this.status = status;
  }
}

export function isTrainingStorageReady(): boolean {
  return isRedisConfigured() && isBlobConfigured();
}

export function trainingStorageHint(): string | null {
  const failed = redisFailure();
  if (failed) {
    return `Storage isn't responding (${failed.message}). Your clips are still there — this is a read failure, not a deletion.`;
  }
  if (isTrainingStorageReady()) return null;
  return "Add the Supabase env vars in Vercel (see docs/supabase-setup.md), then redeploy.";
}

// --- pure helpers (unit-tested) -------------------------------------------

export function newSampleId(language: string, now = Date.now(), rand = Math.random): string {
  const tail = Math.floor(rand() * 0xffffff).toString(16).padStart(6, "0");
  return `${language}-${now.toString(36)}-${tail}`;
}

export function cleanTranscript(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Older clips were saved before speakers existed. */
export const UNNAMED_SPEAKER = "Unnamed";

export function cleanSpeaker(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 40);
}

/** Speakers compare without case, so "bijay" and "Bijay" are one set. */
export function sameSpeaker(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function speakerOf(s: TrainingSample): string {
  return s.speaker || UNNAMED_SPEAKER;
}

/** Every speaker with clips, most clips first, spelled as first recorded. */
export function speakersOf(samples: TrainingSample[]): string[] {
  const counts = new Map<string, { name: string; n: number }>();
  // Oldest first, so "Bijay" typed first stays "Bijay" after a later "bijay".
  for (const s of [...samples].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
    const name = speakerOf(s);
    const c = counts.get(name.toLowerCase()) ?? { name, n: 0 };
    c.n += 1;
    counts.set(name.toLowerCase(), c);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).map((c) => c.name);
}

/** Notes may run over a few lines, but not pages. */
export function cleanDescription(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 500);
}

export function summarize(samples: TrainingSample[]): TrainingSummary[] {
  return TRAINING_LANGUAGES.map((language) => {
    const mine = samples.filter((s) => s.language === language);
    return {
      language,
      clips: mine.length,
      seconds: Math.round(mine.reduce((n, s) => n + s.durationSec, 0) * 10) / 10,
    };
  });
}

/**
 * The dataset as training scripts expect it: one line per clip,
 * `audio|transcript`, the layout LJSpeech made standard. Pipes and line
 * breaks in a transcript would split a row, so they are replaced.
 */
export function toPipeList(samples: TrainingSample[]): string {
  return samples
    .map((s) => `${s.url}|${s.text.replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim()}`)
    .join("\n");
}

// --- store ------------------------------------------------------------------

export async function listSamples(language?: string, speaker?: string): Promise<TrainingSample[]> {
  const all = (await kvScan<TrainingSample>(PREFIX)).filter((s) => s && s.id);
  return all
    .filter((s) => !language || s.language === language)
    .filter((s) => !speaker || sameSpeaker(speakerOf(s), speaker))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getSample(id: string): Promise<TrainingSample | null> {
  return kvGet<TrainingSample>(KEY(id));
}

export interface AddSampleInput {
  language: string;
  speaker: string;
  text: string;
  description?: string;
  source: "prompt" | "free";
  promptId?: string;
  wav: ArrayBuffer;
  checks?: TrainingSample["checks"];
}

export async function addSample(input: AddSampleInput): Promise<TrainingSample> {
  if (!isTrainingStorageReady()) throw new TrainingError(trainingStorageHint() ?? "Storage isn't connected.", 503);
  if (!isTrainingLanguage(input.language)) {
    throw new TrainingError(`Training is available for ${TRAINING_LANGUAGES.join(" and ")} only.`);
  }
  const text = cleanTranscript(input.text);
  if (!text) throw new TrainingError("Type exactly what was said.");
  if (text.length > 1000) throw new TrainingError("That transcript is too long for one clip.");
  if (input.wav.byteLength > MAX_SAMPLE_BYTES) throw new TrainingError("That clip is too large.", 413);
  const speaker = cleanSpeaker(input.speaker);
  if (!speaker) throw new TrainingError("Name the speaker, so their clips stay in one set.");
  const description = cleanDescription(input.description ?? "");

  let meta;
  try {
    meta = readWavMeta(input.wav);
  } catch {
    throw new TrainingError("That isn't a readable WAV file.");
  }
  // The browser converts every clip to this exact format; anything else means
  // a clip that skipped the checks and would train badly.
  if (meta.sampleRate !== TRAINING_SAMPLE_RATE || meta.channels !== 1 || meta.bitsPerSample !== 16) {
    throw new TrainingError(
      `Clips must be ${TRAINING_SAMPLE_RATE / 1000} kHz mono 16-bit WAV (got ${meta.sampleRate} Hz, ${meta.channels} ch, ${meta.bitsPerSample}-bit).`
    );
  }
  if (meta.durationSec < MIN_CLIP_SEC - 0.05 || meta.durationSec > MAX_CLIP_SEC + 0.05) {
    throw new TrainingError(`Clips must be ${MIN_CLIP_SEC}–${MAX_CLIP_SEC} seconds (this one is ${meta.durationSec.toFixed(1)}s).`);
  }

  const id = newSampleId(input.language);
  const path = `training/${input.language}/${id}.wav`;
  const stored = await putBlob(path, input.wav, "audio/wav", {
    kind: "training",
    language: input.language,
    text,
    duration: meta.durationSec,
  });
  const now = Date.now();
  const sample: TrainingSample = {
    id,
    language: input.language,
    speaker,
    text,
    ...(description ? { description } : {}),
    source: input.source,
    ...(input.source === "prompt" && input.promptId ? { promptId: input.promptId } : {}),
    path,
    url: stored.url,
    durationSec: Math.round(meta.durationSec * 100) / 100,
    sizeBytes: input.wav.byteLength,
    ...(input.checks ? { checks: input.checks } : {}),
    createdAt: now,
    updatedAt: now,
  };

  // kvSet swallows its errors and returns false. A clip in the bucket with no
  // record would be invisible and undeletable from the page, so undo the
  // upload and say so instead.
  if (!(await kvSet(KEY(id), sample))) {
    await deleteBlob(path);
    throw new TrainingError("Couldn't record the clip. Nothing was saved — try again.", 503);
  }
  return sample;
}

/** Fix a clip's transcript and/or description; whichever is left out stays. */
export async function updateSample(
  id: string,
  change: { text?: string; description?: string }
): Promise<TrainingSample | null> {
  const existing = await getSample(id);
  if (!existing) return null;
  const next: TrainingSample = { ...existing, updatedAt: Date.now() };
  if (change.text !== undefined) {
    const clean = cleanTranscript(change.text);
    if (!clean) throw new TrainingError("The transcript can't be empty.");
    if (clean.length > 1000) throw new TrainingError("That transcript is too long for one clip.");
    next.text = clean;
  }
  if (change.description !== undefined) {
    const desc = cleanDescription(change.description);
    if (desc) next.description = desc;
    else delete next.description;
  }
  if (!(await kvSet(KEY(id), next))) throw new TrainingError("Couldn't save the change.", 503);
  return next;
}

export async function deleteSample(id: string): Promise<boolean> {
  const existing = await getSample(id);
  if (!existing) return false;
  await deleteBlob(existing.path);
  await kvDel(KEY(id));
  return true;
}
