/**
 * App state (Zustand) + the sequential generation queue.
 *
 * Invariants:
 * - Generation is SEQUENTIAL — one /generate in flight, ever. One GPU.
 * - Every completed chunk is written to IndexedDB the moment it returns.
 * - A network failure pauses the queue and keeps everything already done.
 */

import { create } from "zustand";
import { BackendError } from "./backend";
import {
  deleteLibraryVoice,
  fetchGatewayStatus,
  gatewayGenerate,
  type GatewayGenerateBody,
  type StudioVoice,
} from "./gateway";
import { chunkScript } from "./chunker";
import { DEFAULT_PARAMS, LANGUAGES, MAX_ATTEMPTS } from "./config";
import * as db from "./db";
import { toast } from "./toast";
import type {
  BackendStatus,
  Chunk,
  ChunkDraft,
  GenParams,
  ModelId,
  Project,
} from "./types";

export interface QueueState {
  running: boolean;
  paused: boolean;
  /** Backend went away mid-run — show the "nothing is lost" banner. */
  offline: boolean;
  currentChunkId: string | null;
  /** Rolling average seconds per generated chunk, for the ETA. */
  avgGenSec: number;
}

interface AppState {
  hydrated: boolean;
  backend: BackendStatus;
  connecting: boolean;
  /** The central library, loaded from the server — not this browser. */
  voices: StudioVoice[];
  /** Set when storage isn't connected, so the UI can say what to do. */
  storageHint: string | null;
  /** "word -> spoken form" pairs from Admin → Settings, used when chunking. */
  pronunciations: Record<string, string>;
  activeVoiceId: string | null;
  project: Project;
  queue: QueueState;
  /** For the ARIA live region — announces chunk completion. */
  announcement: string;

  hydrate(): Promise<void>;
  /** Re-read which backend is live and which voices exist. */
  connect(opts?: { silent?: boolean }): Promise<boolean>;
  /** Called after an upload so the new voice appears and is selected. */
  noteNewVoice(voice: StudioVoice): Promise<void>;
  removeVoice(id: string): Promise<void>;
  setActiveVoice(id: string | null): void;
  setScript(raw: string): void;
  setModel(model: ModelId): void;
  setParams(patch: Partial<GenParams>): void;
  startGeneration(mode: "all" | "remaining"): Promise<void>;
  pauseGeneration(): void;
  resumeGeneration(): void;
  stopGeneration(): void;
  regenerateChunk(id: string, newText?: string): Promise<void>;
  /** One-off generation outside the queue, for A/B compare. */
  generateOnce(text: string, model: ModelId, seed: number): Promise<{
    blob: Blob;
    durationSec: number;
    genSeconds: number;
  }>;
}

function createDefaultProject(): Project {
  return {
    id: crypto.randomUUID(),
    name: "Untitled session",
    voiceId: "",
    model: "chatterbox",
    params: { ...DEFAULT_PARAMS },
    scriptRaw: "",
    chunks: [],
    updatedAt: Date.now(),
  };
}

function newChunk(draft: ChunkDraft, index: number, baseSeed: number): Chunk {
  return {
    id: crypto.randomUUID(),
    index,
    text: draft.text,
    charCount: draft.charCount,
    status: "pending",
    seed: baseSeed + index,
    attempts: 0,
    isParagraphEnd: draft.isParagraphEnd,
  };
}

/**
 * Rebuild the chunk list from fresh drafts, keeping status + audio for any
 * chunk whose text is unchanged so an edit never throws away finished work.
 */
function reconcileChunks(drafts: ChunkDraft[], old: Chunk[], baseSeed: number): Chunk[] {
  const pool = new Map<string, Chunk[]>();
  for (const c of old) {
    const list = pool.get(c.text) ?? [];
    list.push(c);
    pool.set(c.text, list);
  }
  return drafts.map((d, i) => {
    const match = pool.get(d.text)?.shift();
    if (match) {
      return { ...match, index: i, charCount: d.charCount, isParagraphEnd: d.isParagraphEnd };
    }
    return newChunk(d, i, baseSeed);
  });
}

function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** Monotonic token — bumping it makes any in-flight queue loop stand down. */
let runToken = 0;

export const useApp = create<AppState>((set, get) => {
  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      void db.putProject({ ...get().project, updatedAt: Date.now() });
    }, 400);
  };

  const updateChunk = (id: string, patch: Partial<Chunk>) => {
    set((s) => ({
      project: {
        ...s.project,
        chunks: s.project.chunks.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      },
    }));
    schedulePersist();
  };

  const setQueue = (patch: Partial<QueueState>) =>
    set((s) => ({ queue: { ...s.queue, ...patch } }));

  /**
   * No cloning step any more. A library voice is referenced by id and the
   * gateway caches it on whichever GPU answers — including after a Colab
   * restart, which is exactly the case that used to force a re-clone.
   */
  const buildBody = (chunk: Chunk): GatewayGenerateBody => {
    const { model, params, voiceId } = get().project;
    return {
      text: chunk.text,
      voiceId,
      model,
      seed: chunk.seed,
      language: params.language,
      exaggeration: params.exaggeration,
      cfg: params.cfg,
      temperature: params.temperature,
      stylePrompt: params.stylePrompt,
    };
  };

  /**
   * The queue. Picks pending chunks one at a time (optionally restricted to
   * `only`), generates, saves. Retries live here too: a failed chunk goes
   * back to pending with a fresh seed until MAX_ATTEMPTS, then is marked
   * failed and the queue moves on.
   */
  const runQueue = async (only: Set<string> | null) => {
    const token = ++runToken;
    setQueue({ running: true, paused: false, offline: false });

    while (runToken === token) {
      if (get().queue.paused) {
        await sleep(300);
        continue;
      }
      const chunk = get().project.chunks.find(
        (c) => c.status === "pending" && (!only || only.has(c.id))
      );
      if (!chunk) break;

      updateChunk(chunk.id, { status: "generating" });
      setQueue({ currentChunkId: chunk.id });

      try {
        const t0 = performance.now();
        const result = await gatewayGenerate(buildBody(chunk));
        const wallSec = (performance.now() - t0) / 1000;

        // Save first — IndexedDB before UI, so a crash can't lose the chunk.
        await db.saveChunkAudio(
          get().project.id,
          chunk.id,
          result.audioBlob,
          result.durationSec,
          result.sampleRate
        );
        updateChunk(chunk.id, {
          status: "done",
          audioBlob: result.audioBlob,
          durationSec: result.durationSec,
          sampleRate: result.sampleRate,
          error: undefined,
        });
        set((s) => ({
          queue: {
            ...s.queue,
            avgGenSec: s.queue.avgGenSec
              ? s.queue.avgGenSec * 0.7 + wallSec * 0.3
              : wallSec,
          },
          announcement: `Chunk ${chunk.index + 1} of ${s.project.chunks.length} finished`,
        }));
      } catch (e) {
        if (runToken !== token) break;
        const err = e instanceof BackendError ? e : new BackendError(String(e), "api");

        if (err.kind === "network") {
          // The GPU went away. Pause everything, lose nothing.
          updateChunk(chunk.id, { status: "pending" });
          const doneCount = get().project.chunks.filter((c) => c.status === "done").length;
          setQueue({ running: false, currentChunkId: null, offline: true });
          set((s) => ({ backend: { ...s.backend, connected: false } }));
          set({
            announcement: `Backend went offline. ${doneCount} chunks are saved.`,
          });
          toast(err.message, "error");
          return;
        }

        const attempts = chunk.attempts + 1;
        if (attempts < MAX_ATTEMPTS) {
          updateChunk(chunk.id, {
            status: "pending",
            attempts,
            seed: randomSeed(),
            error: err.message,
          });
        } else {
          updateChunk(chunk.id, { status: "failed", attempts, error: err.message });
          toast(`Chunk ${chunk.index + 1} failed: ${err.message}`, "error");
        }
      }
    }

    if (runToken === token) {
      setQueue({ running: false, paused: false, currentChunkId: null });
    }
  };

  // -------------------------------------------------------------------------
  // store
  // -------------------------------------------------------------------------

  return {
    hydrated: false,
    backend: { connected: false, url: "", modelsLoaded: [] },
    connecting: false,
    voices: [],
    storageHint: null,
    pronunciations: {},
    activeVoiceId: null,
    project: createDefaultProject(),
    queue: {
      running: false,
      paused: false,
      offline: false,
      currentChunkId: null,
      avgGenSec: 0,
    },
    announcement: "",

    async hydrate() {
      // Storage must NEVER be able to block startup. If IndexedDB is slow,
      // blocked by another tab mid-upgrade, or disabled outright, we come up
      // with an empty session instead of leaving the user staring at
      // "Loading your session…" forever.
      try {
        let project = await db.getFirstProject();
        if (!project) {
          project = createDefaultProject();
        } else {
          const audio = await db.loadAllChunkAudio(project.id);
          project = {
            ...project,
            chunks: project.chunks.map((c) => {
              const stored = audio.get(c.id);
              if (c.status === "done" && stored) {
                return {
                  ...c,
                  audioBlob: stored.blob,
                  durationSec: stored.durationSec,
                  sampleRate: stored.sampleRate,
                };
              }
              if (c.status === "done" || c.status === "generating") {
                return { ...c, status: "pending" as const, audioBlob: undefined };
              }
              return c;
            }),
          };
        }
        set({
          hydrated: true,
          project: {
            ...project,
            // older saved projects predate newer params (e.g. language)
            params: { ...DEFAULT_PARAMS, ...project.params },
          },
        });
      } catch (e) {
        console.warn("[voiceforge] starting without saved data:", e);
        set({ hydrated: true });
        toast(
          "Couldn't load saved data. Close any other VoiceForge tabs and reload.",
          "error"
        );
      }

      // Voices and the live backend come from the server, so there's always
      // something to fetch — no saved URL to decide on first.
      void get().connect({ silent: true });
    },

    /**
     * One call answers both "where would a chunk run right now" and "which
     * voices exist". The studio holds no URL and no clip of its own.
     */
    async connect(opts) {
      set({ connecting: true });
      try {
        const status = await fetchGatewayStatus();
        const voices = status.voices;

        // Keep the current pick if it's still in the library; otherwise fall
        // back to the default so a fresh browser can generate immediately.
        const keep = voices.find((v) => v.id === get().project.voiceId);
        const activeVoiceId =
          keep?.id ?? voices.find((v) => v.isDefault)?.id ?? voices[0]?.id ?? null;

        set((s) => ({
          connecting: false,
          voices,
          storageHint: status.hint,
          pronunciations: status.pronunciations ?? {},
          activeVoiceId,
          project: { ...s.project, voiceId: activeVoiceId ?? "" },
          backend: {
            connected: Boolean(status.backend),
            url: status.backend?.provider ?? "",
            gpu: status.backend?.gpu ?? undefined,
            modelsLoaded: (status.backend?.models ?? []) as ModelId[],
            health: status.backend?.health,
          },
        }));

        if (!status.backend && !opts?.silent) {
          toast("No GPU backend is online. Start a notebook, then try again.", "error");
        }
        return Boolean(status.backend);
      } catch {
        set((s) => ({ connecting: false, backend: { ...s.backend, connected: false } }));
        if (!opts?.silent) toast("Couldn't reach the server.", "error");
        return false;
      }
    },

    async noteNewVoice(voice: StudioVoice) {
      set((s) => ({
        voices: [voice, ...s.voices.filter((v) => v.id !== voice.id)],
        activeVoiceId: voice.id,
        project: { ...s.project, voiceId: voice.id },
      }));
      schedulePersist();
      // Re-read so the default flag and ordering match the server.
      void get().connect({ silent: true });
    },

    async removeVoice(id: string) {
      try {
        await deleteLibraryVoice(id);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Couldn't delete that voice.", "error");
        return;
      }
      set((s) => {
        const voices = s.voices.filter((v) => v.id !== id);
        const activeVoiceId = s.activeVoiceId === id ? voices[0]?.id ?? null : s.activeVoiceId;
        return {
          voices,
          activeVoiceId,
          project: { ...s.project, voiceId: activeVoiceId ?? "" },
        };
      });
      schedulePersist();
    },

    setActiveVoice(id: string | null) {
      set((s) => ({ activeVoiceId: id, project: { ...s.project, voiceId: id ?? "" } }));
      // A voice brings its language with it. The Language setting used to stay
      // wherever it was, so picking the English voice after a Nepali test kept
      // sending English text to the Nepali model. It can still be changed by
      // hand afterwards for the rare cross-language read.
      const language = get().voices.find((v) => v.id === id)?.language;
      if (
        language &&
        language !== get().project.params.language &&
        LANGUAGES.some((l) => l.code === language) &&
        !get().queue.running
      ) {
        get().setParams({ language });
      }
      schedulePersist();
    },

    setScript(raw: string) {
      if (get().queue.running) return; // editor is locked during a run
      const drafts = chunkScript(raw, undefined, get().project.params.language, {
        pronunciations: get().pronunciations,
      });
      set((s) => {
        const chunks = reconcileChunks(drafts, s.project.chunks, s.project.params.seed);
        // clean up stored audio for chunks that no longer exist
        const keep = new Set(chunks.map((c) => c.id));
        for (const old of s.project.chunks) {
          if (!keep.has(old.id) && old.status === "done") {
            void db.deleteChunkAudio(s.project.id, old.id);
          }
        }
        return { project: { ...s.project, scriptRaw: raw, chunks } };
      });
      schedulePersist();
    },

    setModel(model: ModelId) {
      set((s) => ({ project: { ...s.project, model } }));
      schedulePersist();
    },

    setParams(patch: Partial<GenParams>) {
      set((s) => ({ project: { ...s.project, params: { ...s.project.params, ...patch } } }));
      // language changes normalization + sentence rules — re-chunk the script
      if (patch.language !== undefined && !get().queue.running) {
        get().setScript(get().project.scriptRaw);
      }
      schedulePersist();
    },

    async startGeneration(mode: "all" | "remaining") {
      const s = get();
      if (s.queue.running) return;
      if (!s.backend.connected) {
        toast("No GPU backend is online. Start your notebook, then hit Refresh.", "error");
        return;
      }
      if (!s.project.voiceId) {
        toast("Add a voice first.", "error");
        return;
      }
      if (s.project.chunks.length === 0) {
        toast("Add a script first.", "error");
        return;
      }

      if (mode === "all") {
        await db.clearProjectAudio(s.project.id);
        set((st) => ({
          project: {
            ...st.project,
            chunks: st.project.chunks.map((c, i) => ({
              ...c,
              status: "pending" as const,
              attempts: 0,
              seed: st.project.params.seed + i,
              audioBlob: undefined,
              durationSec: undefined,
              error: undefined,
            })),
          },
        }));
      } else {
        set((st) => ({
          project: {
            ...st.project,
            chunks: st.project.chunks.map((c) =>
              c.status === "failed"
                ? { ...c, status: "pending" as const, attempts: 0, error: undefined }
                : c
            ),
          },
        }));
      }
      schedulePersist();
      void runQueue(null);
    },

    pauseGeneration() {
      if (get().queue.running) setQueue({ paused: true });
    },

    resumeGeneration() {
      setQueue({ paused: false });
    },

    stopGeneration() {
      runToken++; // any in-flight loop stands down; a finishing chunk still saves
      set((s) => ({
        queue: { ...s.queue, running: false, paused: false, currentChunkId: null },
        project: {
          ...s.project,
          chunks: s.project.chunks.map((c) =>
            c.status === "generating" ? { ...c, status: "pending" as const } : c
          ),
        },
      }));
      schedulePersist();
    },

    async regenerateChunk(id: string, newText?: string) {
      const s = get();
      if (s.queue.running) return;
      const chunk = s.project.chunks.find((c) => c.id === id);
      if (!chunk) return;
      updateChunk(id, {
        text: newText?.trim() || chunk.text,
        charCount: (newText?.trim() || chunk.text).length,
        status: "pending",
        attempts: 0,
        seed: randomSeed(),
        error: undefined,
      });
      void runQueue(new Set([id]));
    },

    async generateOnce(text: string, model: ModelId, seed: number) {
      const s = get();
      const { params } = s.project;
      const result = await gatewayGenerate({
        text,
        voiceId: s.project.voiceId,
        model,
        seed,
        language: params.language,
        exaggeration: params.exaggeration,
        cfg: params.cfg,
        temperature: params.temperature,
        stylePrompt: params.stylePrompt,
      });
      return {
        blob: result.audioBlob,
        durationSec: result.durationSec,
        genSeconds: result.genSeconds,
      };
    },
  };
});
