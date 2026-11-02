export type ModelId = "chatterbox" | "qwen3";

export interface Voice {
  id: string;
  name: string;
  createdAt: number;
  sampleBlob: Blob; // reference audio, 10–20s, trimmed WAV
  sampleMime: string;
  transcript: string; // exact transcript of sampleBlob — required for Qwen3
  durationSec: number;
  /**
   * The voice_id currently cached on the backend. Colab sessions are
   * ephemeral — when the runtime restarts this goes stale and the app
   * silently re-clones from sampleBlob.
   */
  remoteId?: string;
}

export type ChunkStatus = "pending" | "generating" | "done" | "failed";

export interface Chunk {
  id: string;
  index: number;
  text: string;
  charCount: number;
  status: ChunkStatus;
  seed: number;
  audioBlob?: Blob;
  durationSec?: number;
  sampleRate?: number;
  error?: string;
  attempts: number;
  /** True when this chunk closes a paragraph — the stitcher uses the longer gap. */
  isParagraphEnd: boolean;
}

/** What the chunker emits before chunks are materialized for generation. */
export interface ChunkDraft {
  text: string;
  charCount: number;
  isParagraphEnd: boolean;
}

export interface Project {
  id: string;
  name: string;
  voiceId: string;
  model: ModelId;
  params: GenParams;
  scriptRaw: string;
  chunks: Chunk[];
  updatedAt: number;
}

export interface GenParams {
  // shared
  seed: number; // base seed; chunk seed = seed + chunk.index
  speed: number; // 0.8–1.2, default 1.0 (reserved — backend doesn't apply it yet)
  /** ISO 639-1 code sent to the backend (Chatterbox Multilingual language_id). */
  language: string;
  // chatterbox
  exaggeration: number; // 0.25–2.0, default 0.4 for narration
  cfg: number; // 0.2–1.0, default 0.5
  temperature: number; // 0.5–1.0, default 0.7
  // qwen3
  stylePrompt: string; // e.g. "Calm, clear, informative narration"
}

export type ConnectionMode = "direct" | "proxy";

export interface BackendStatus {
  connected: boolean;
  url: string;
  gpu?: string;
  modelsLoaded: ModelId[];
  latencyMs?: number;
  mode?: ConnectionMode;
  /** voice_ids currently cached on the backend (from /health). */
  remoteVoices?: string[];
  /** Registry health of the serving backend ("online" / "busy" / …), for the studio's status pill. */
  health?: string;
}

export interface GenerateResult {
  audioBlob: Blob;
  sampleRate: number;
  durationSec: number;
  genSeconds: number;
}

// ---------------------------------------------------------------------------
// GPU backend registry (platform v2)
// ---------------------------------------------------------------------------

export type BackendProvider = "modal" | "colab" | "kaggle" | "custom";

export const BACKEND_PROVIDERS: BackendProvider[] = ["modal", "colab", "kaggle", "custom"];

/** "auto" picks the first enabled+online backend by priority. */
export type ActiveBackend = "auto" | BackendProvider;

export type BackendHealthKind =
  | "online"
  | "busy"
  | "offline"
  | "disabled"
  /**
   * Enabled, but nothing has ever answered at this address. Only reachable by
   * a hand-added backend: a notebook proves itself by heartbeating, while a
   * typed-in URL is just a claim until something responds to it.
   */
  | "unverified";

/** What a backend sends when it registers itself / heartbeats. */
export interface BackendRegistration {
  provider: BackendProvider;
  url: string;
  gpu?: string;
  models?: string[];
  version?: string;
  /**
   * Where video renders go, when that is a different address from TTS.
   * Colab and Kaggle serve both from one tunnel and leave this unset; Modal
   * sets it to its CPU-only function so rendering never bills a T4.
   */
  renderUrl?: string;
  /** What this backend can actually do — defaults to ["tts"]. */
  capabilities?: string[];
  /**
   * Where presenter clips go, when that is a different address from voice
   * (Modal runs them in their own function). Unset means the main url.
   */
  presenterUrl?: string;
  /**
   * What the presenter address reported it can do. Kept apart from
   * `capabilities`, which is rewritten from the voice server's /health on
   * every probe and knows nothing about presenter video.
   */
  presenterCapabilities?: string[];
  /** When the presenter address was last asked, and which address that was. */
  presenterProbedAt?: number;
  presenterProbedUrl?: string;
  /** What the presenter address said about its engine install, if anything. */
  presenterNote?: string;
  /**
   * AI video clips (Wan). Same shape as the presenter fields, kept apart for
   * the same reason: the voice server's /health knows nothing about them.
   * wanUrl is where clips go (Modal: its own app; a notebook: <tunnel>/wan).
   */
  wanUrl?: string;
  /** What the Wan address reported, e.g. ["text-to-video"] once ready. */
  wanCapabilities?: string[];
  wanProbedAt?: number;
  wanProbedUrl?: string;
  /** What the Wan address said about its install, if anything. */
  wanNote?: string;
  /** Sizes, frame counts and defaults the Wan backend advertised. */
  wanLimits?: Record<string, unknown>;
}

/** A row in the registry, as stored. */
export interface RegisteredBackend extends BackendRegistration {
  models: string[];
  registeredAt: number;
  lastHeartbeat: number;
  enabled: boolean;
  /** Lower wins when the active selection is "auto". */
  priority: number;
  /**
   * True when a notebook registered itself and keeps heartbeating. False for
   * a URL typed into the admin panel (Modal, custom), which has no heartbeat
   * and must NOT be aged out — see computeHealth.
   */
  selfRegistered?: boolean;
  busy?: boolean;
  voicesCached?: string[];
  /** Summed from job gen_seconds — used for the Modal free-credit gauge. */
  gpuSecondsMonth?: number;
  jobsToday?: number;
  lastError?: string;
  /**
   * When we last got a real answer from this address — a health probe or an
   * accepted job. For Modal and custom URLs this is the only liveness
   * evidence there is, because they never heartbeat.
   */
  lastReachedAt?: number;
  /** Why the last attempt to reach it failed, if it did. */
  lastReachError?: string;
  /**
   * Per-feature switches (Admin → Backends: Voice / Presenter / AI video).
   * Absent means on. All are separate from `enabled`, which governs the
   * backend as a whole, so a notebook can keep doing voice while video goes
   * elsewhere, or nowhere — and Modal can be kept out of any one feature.
   *
   * `videoEnabled` is the Presenter switch; the name predates AI video and is
   * kept so stored rows keep their meaning.
   */
  videoEnabled?: boolean;
  /** Voice (TTS) switch. */
  voiceEnabled?: boolean;
  /** AI video clips (Wan) switch. Also tells a notebook whether to install it. */
  clipsEnabled?: boolean;
  /** Disk and GPU memory, from a notebook's last heartbeat. */
  system?: BackendSystem;
  /** Set when a notebook stopped itself after sitting idle (Admin -> Settings). */
  stoppedIdleAt?: number;
}

export interface BackendSystem {
  at: number;
  /** Seconds since it last did any work; 0 while working. */
  idleSeconds?: number;
  diskFreeGb?: number;
  diskTotalGb?: number;
  gpus?: Array<{ name: string; usedMb: number; totalMb: number }>;
}

/** Registry row plus the status computed at read time. */
export interface BackendView extends RegisteredBackend {
  health: BackendHealthKind;
  secondsSinceHeartbeat: number;
  /** null when nothing has ever answered here. */
  secondsSinceReached: number | null;
}

// ---------------------------------------------------------------------------
// Central voice library (platform v2)
// ---------------------------------------------------------------------------

/**
 * A voice that lives on the server, not in one browser.
 *
 * The reference clip sits in Vercel Blob at a public URL; backends download it
 * themselves the first time they're asked to use the voice. That's what makes
 * "clone once, works everywhere" true — a Colab restart loses its local cache,
 * not the voice.
 */
export interface LibraryVoice {
  id: string;
  name: string;
  /** ISO 639-1, passed through to Chatterbox as language_id. */
  language: string;
  /**
   * Optional per-voice synthesis overrides. Beaten by a request's own params,
   * beats the language profile. Absent for every voice unless set by hand.
   */
  synth?: {
    engine?: string;
    exaggeration?: number;
    cfg?: number;
    temperature?: number;
  };
  /**
   * Other library voices of the same speaker, used by expressive narration:
   * `en` voices the English words in a code-switched Nepali script, and the
   * tone slots voice sentences tagged [calm] / [excited] / [serious]. Each is
   * just another uploaded clip — record yourself speaking English, or
   * speaking excitedly, and link it here.
   */
  refs?: VoiceRefs;
  /** Exact words spoken in the clip. Required by Qwen3, helps Chatterbox. */
  transcript: string;
  /** Public Blob URL of the reference clip (always 16-bit PCM WAV). */
  audioUrl: string;
  durationSec: number;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
}

export const VOICE_REF_SLOTS = ["en", "calm", "excited", "serious"] as const;
export type VoiceRefSlot = (typeof VOICE_REF_SLOTS)[number];
export type VoiceRefs = Partial<Record<VoiceRefSlot, string>>;

/** Library row plus whether it's the default pick. */
export interface LibraryVoiceView extends LibraryVoice {
  isDefault: boolean;
}

// ---------------------------------------------------------------------------
// Video renders (moved out of VoiceForge; old job records still carry this)
// ---------------------------------------------------------------------------

/** Where each scene lands in the finished MP4 — YouTube chapters, mostly. */
export interface VideoChapterSpan {
  index: number;
  /**
   * Which part of the video this is. Filtering to "scene" lines the timeline
   * up with the scenes the caller sent, whatever bookends were added — the
   * length alone cannot distinguish one intro from one outro.
   */
  kind: "intro" | "scene" | "outro";
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Training clips (recordings + exact transcripts, for fine-tuning a voice)
// ---------------------------------------------------------------------------

export interface TrainingSample {
  id: string;
  /** "ne" or "en" — see TRAINING_LANGUAGES. */
  language: string;
  /** Whose voice. A training run uses one speaker's clips. Absent on the
   *  earliest clips, which list as "Unnamed". */
  speaker?: string;
  /** Exactly what is said in the clip, word for word. */
  text: string;
  /** Optional notes for people: tone, room, mic. Not speech. */
  description?: string;
  /** Read from the built-in sentence list, or recorded/uploaded freely. */
  source: "prompt" | "free";
  /** Which built-in sentence, when source is "prompt". */
  promptId?: string;
  /** Bucket path and public URL of the 24 kHz mono 16-bit WAV. */
  path: string;
  url: string;
  durationSec: number;
  sizeBytes: number;
  /** Measured in the browser before upload. */
  checks?: { peakDb: number; speechDb: number; longestPauseSec: number; warnings: string[] };
  createdAt: number;
  updatedAt: number;
}

export interface TrainingSummary {
  language: string;
  clips: number;
  seconds: number;
}

// ---------------------------------------------------------------------------
// Presenters (lip-synced intro / outro clips)
// ---------------------------------------------------------------------------

/**
 * What a presenter is made from, which decides how it is voiced.
 *
 * A "recording" is a short video of a real person; the mouth is redrawn to
 * match new audio and everything else stays genuine footage. An "image" is a
 * single still that a generative model animates from nothing. They need
 * different engines and very different hardware, so the kind is stored rather
 * than guessed from the file.
 */
export const PRESENTER_KINDS = ["recording", "image"] as const;
export type PresenterKind = (typeof PRESENTER_KINDS)[number];

/** Whose face it is. Asked at upload; a real person needs their permission. */
export const PRESENTER_SOURCES = ["self", "generated", "permission"] as const;
export type PresenterSource = (typeof PRESENTER_SOURCES)[number];

export interface Presenter {
  id: string;
  name: string;
  kind: PresenterKind;
  /** Public Blob URL — the backend downloads from here. */
  url: string;
  mime: string;
  sizeBytes: number;
  /** Recordings only. */
  durationSec?: number;
  source: PresenterSource;
  createdAt: number;
  updatedAt: number;
}

export interface PresenterView extends Presenter {
  isDefault: boolean;
}
