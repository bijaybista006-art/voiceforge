"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeAudioBlob, encodeWavPcm16, formatDuration } from "@/lib/audio";
import { LANGUAGES, SAMPLE_IDEAL_MAX_SEC, SAMPLE_IDEAL_MIN_SEC } from "@/lib/config";
import { toast } from "@/lib/toast";
import type { LibraryVoiceView, VoiceRefSlot } from "@/lib/types";
import { checkReference, speechBounds } from "@/lib/voiceReference";
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
    return <div className="glass-card px-5 py-8 text-center text-sm text-muted">Loading…</div>;
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
              if (!window.confirm(`Delete "${v.name}"? The clip is removed from storage.`)) return;
              void act(`/api/admin/voices/${v.id}`, { method: "DELETE" }, `delete-${v.id}`);
            }}
          />
        ))
      )}
    </div>
  );
}

// --- add ------------------------------------------------------------------

function AddVoiceCard({ disabled, onAdded }: { disabled: boolean; onAdded: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [wav, setWav] = useState<{
    blob: Blob;
    durationSec: number;
    fileName: string;
    trimmedSec: number;
    warnings: string[];
  } | null>(null);
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("en");
  const [transcript, setTranscript] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!wav) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(wav.blob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [wav]);

  /**
   * Decode whatever was picked and re-encode to 16-bit PCM WAV here, in the
   * browser. The backends read clips with soundfile, whose MP3 support depends
   * on the libsndfile build on the GPU host — so we never send one.
   */
  async function onPick(file: File) {
    setPreparing(true);
    try {
      const decoded = await decodeAudioBlob(file);
      // Silence before the first word is copied into every generated clip,
      // so it is cut here; see lib/voiceReference.ts.
      const lead = speechBounds(decoded.samples, decoded.sampleRate)?.start ?? 0;
      const cut = lead > 0.1 ? Math.floor((lead - 0.05) * decoded.sampleRate) : 0;
      const pcm = { samples: decoded.samples.slice(cut), sampleRate: decoded.sampleRate };
      const durationSec = pcm.samples.length / pcm.sampleRate;
      setWav({
        blob: encodeWavPcm16(pcm),
        durationSec,
        fileName: file.name,
        trimmedSec: cut / decoded.sampleRate,
        warnings: checkReference(pcm.samples, pcm.sampleRate).warnings,
      });
      if (!name) setName(file.name.replace(/\.[^.]+$/, "").slice(0, 60));
    } catch {
      toast("Couldn't read that audio file. Try a WAV, MP3 or M4A.", "error");
    } finally {
      setPreparing(false);
    }
  }

  async function submit() {
    if (!wav) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("audio", wav.blob, "reference.wav");
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
      setWav(null);
      setName("");
      setTranscript("");
      if (fileInput.current) fileInput.current.value = "";
      onAdded();
    } catch {
      toast("Couldn't reach the server.", "error");
    } finally {
      setUploading(false);
    }
  }

  const tooShort = wav !== null && wav.durationSec < 4;
  const canSubmit = Boolean(wav && name.trim() && !tooShort && !uploading && !disabled);

  return (
    <div className="glass-card overflow-hidden">
      <div className="border-b border-line bg-surface2 px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">Add a voice</h2>
        <p className="mt-0.5 text-[12.5px] text-muted">
          Clone your own voice, or one you have explicit permission to clone.
        </p>
      </div>

      <div className="space-y-4 px-5 py-4">
        {/* The file input is its own control with a visible button — never
            wrapped in a label that also holds other inputs, which silently
            swallows the click. */}
        <div>
          <label className="mb-1.5 block text-[12.5px] font-medium text-muted">
            Reference clip
          </label>
          <input
            ref={fileInput}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onPick(f);
            }}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              disabled={preparing || uploading}
              onClick={() => fileInput.current?.click()}
            >
              <IconUpload className="h-3.5 w-3.5" />
              {preparing ? "Reading…" : "Choose file"}
            </Button>
            {wav ? (
              <span className="text-[12.5px] text-muted">
                {wav.fileName} · {formatDuration(wav.durationSec)}
              </span>
            ) : (
              <span className="text-[12.5px] text-faint">
                {SAMPLE_IDEAL_MIN_SEC}–{SAMPLE_IDEAL_MAX_SEC}s of clean speech, no music
              </span>
            )}
          </div>
          {previewUrl ? (
            <audio src={previewUrl} controls className="mt-3 h-9 w-full max-w-sm" />
          ) : null}
          {tooShort ? (
            <p className="mt-2 text-[12px] text-live">
              That clip is under 4 seconds — too short to clone reliably.
            </p>
          ) : null}
          {wav && wav.trimmedSec > 0 ? (
            <p className="mt-2 text-[12px] text-muted">
              Cut {wav.trimmedSec.toFixed(1)}s of silence from the start, so generated speech starts on time.
            </p>
          ) : null}
          {wav?.warnings.map((w) => (
            <p key={w} className="mt-2 flex gap-2 text-[12px] text-live">
              <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {w}
            </p>
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-muted" htmlFor="vf-name">
              Name
            </label>
            <Input
              id="vf-name"
              value={name}
              maxLength={80}
              placeholder="My narration voice"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-muted" htmlFor="vf-lang">
              Language
            </label>
            <Select
              id="vf-lang"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div>
          <label
            className="mb-1.5 block text-[12.5px] font-medium text-muted"
            htmlFor="vf-transcript"
          >
            Transcript <span className="text-faint">— the exact words in the clip</span>
          </label>
          <Textarea
            id="vf-transcript"
            rows={3}
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder="Type exactly what is said in the clip."
          />
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-line bg-surface2 px-5 py-3">
        <p className="text-[12px] text-muted">
          Stored once. Cached onto any backend the first time it&apos;s used.
        </p>
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
