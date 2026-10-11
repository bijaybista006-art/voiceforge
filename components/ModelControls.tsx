"use client";

import { useState } from "react";
import { formatDuration } from "@/lib/audio";
import { LANGUAGES, MODEL_INFO } from "@/lib/config";
import { useApp } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { ModelId } from "@/lib/types";
import { Button } from "./ui/Button";
import { FieldLabel } from "./ui/Card";
import { Dialog } from "./ui/Dialog";
import { IconSparkle } from "./ui/Icons";
import { Input } from "./ui/Input";
import { Select } from "./ui/Select";
import { Slider } from "./ui/Slider";

interface AbResult {
  model: ModelId;
  url: string;
  genSeconds: number;
  durationSec: number;
}

function AbCompareDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const chunks = useApp((s) => s.project.chunks);
  const params = useApp((s) => s.project.params);
  const generateOnce = useApp((s) => s.generateOnce);
  const setModel = useApp((s) => s.setModel);
  const modelsLoaded = useApp((s) => s.backend.modelsLoaded);

  const [chunkId, setChunkId] = useState<string>("");
  const [busy, setBusy] = useState<ModelId | null>(null);
  const [results, setResults] = useState<AbResult[]>([]);

  const chunk = chunks.find((c) => c.id === chunkId) ?? chunks[0];

  async function run() {
    if (!chunk) return;
    setResults([]);
    try {
      for (const model of ["chatterbox", "qwen3"] as ModelId[]) {
        if (!modelsLoaded.includes(model)) continue;
        setBusy(model);
        const r = await generateOnce(chunk.text, model, params.seed + chunk.index);
        setResults((prev) => [
          ...prev,
          {
            model,
            url: URL.createObjectURL(r.blob),
            genSeconds: r.genSeconds,
            durationSec: r.durationSec,
          },
        ]);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "A/B generation failed.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="A/B compare"
      description="Generates one chunk on both models, back to back. Twenty seconds here saves regenerating twenty minutes."
      wide
    >
      <FieldLabel>Chunk</FieldLabel>
      <Select value={chunk?.id ?? ""} onChange={(e) => setChunkId(e.target.value)} className="mb-4">
        {chunks.map((c) => (
          <option key={c.id} value={c.id}>
            {String(c.index + 1).padStart(2, "0")} · {c.text.slice(0, 60)}
            {c.text.length > 60 ? "…" : ""}
          </option>
        ))}
      </Select>
      <Button variant="primary" disabled={!chunk || busy !== null} onClick={() => void run()}>
        {busy ? `Generating on ${MODEL_INFO[busy].name}…` : "Generate both"}
      </Button>
      <div className="mt-4 flex flex-col gap-3">
        {results.map((r) => (
          <div key={r.model} className="rounded-xl border border-line bg-surface2 p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[13px] font-semibold text-ink">{MODEL_INFO[r.model].name}</span>
              <span className="font-mono text-[11px] tabular-nums text-faint">
                {formatDuration(r.durationSec)} · {r.genSeconds.toFixed(1)}s to render
              </span>
            </div>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio controls src={r.url} className="mb-3 h-9 w-full" />
            <Button
              size="sm"
              onClick={() => {
                setModel(r.model);
                toast(`Model set to ${MODEL_INFO[r.model].name}.`, "success");
                onClose();
              }}
            >
              Use {MODEL_INFO[r.model].name}
            </Button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function ModelControls() {
  const model = useApp((s) => s.project.model);
  const params = useApp((s) => s.project.params);
  const setModel = useApp((s) => s.setModel);
  const setParams = useApp((s) => s.setParams);
  const running = useApp((s) => s.queue.running);
  const connected = useApp((s) => s.backend.connected);
  const modelsLoaded = useApp((s) => s.backend.modelsLoaded);
  const hasVoice = useApp((s) => !!s.project.voiceId);
  const hasChunks = useApp((s) => s.project.chunks.length > 0);
  const [abOpen, setAbOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      {/* model */}
      <div>
        <FieldLabel>Model</FieldLabel>
        <div role="radiogroup" aria-label="Model" className="flex flex-col gap-2">
          {(Object.keys(MODEL_INFO) as ModelId[]).map((id) => {
            const loaded = !connected || modelsLoaded.includes(id);
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={model === id}
                disabled={running || !loaded}
                onClick={() => setModel(id)}
                className={`rounded-xl border px-3.5 py-3 text-left transition-all duration-150 disabled:opacity-40 ${
                  model === id
                    ? "border-audio/40 bg-audioSoft"
                    : "border-line bg-surface2 hover:border-lineStrong"
                }`}
              >
                <span className="block text-[13px] font-semibold text-ink">
                  {MODEL_INFO[id].name}
                  {!loaded ? " — not loaded" : ""}
                </span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">
                  {MODEL_INFO[id].blurb}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* language */}
      <div>
        <FieldLabel>Language</FieldLabel>
        <Select
          value={params.language}
          disabled={running}
          onChange={(e) => setParams({ language: e.target.value })}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </Select>
        <p className="mt-1.5 text-[11.5px] leading-snug text-faint">
          Nepali uses a separate fine-tuned model, loaded on first use. If it
          cannot be loaded, generation fails and says why.
        </p>
      </div>

      {/* expressiveness always visible; the rest tucked away */}
      {model === "chatterbox" ? (
        <Slider
          label="Expressiveness"
          value={params.exaggeration}
          min={0.25}
          max={2}
          step={0.05}
          disabled={running}
          onChange={(v) => setParams({ exaggeration: v })}
          hint="0.4 suits factual narration. Above 0.8 gets theatrical."
        />
      ) : (
        <div>
          <FieldLabel>Delivery style</FieldLabel>
          <Input
            value={params.stylePrompt}
            disabled={running}
            onChange={(e) => setParams({ stylePrompt: e.target.value })}
            placeholder="Calm, clear, informative narration"
          />
        </div>
      )}

      <button
        type="button"
        onClick={() => setAdvanced((v) => !v)}
        className="-my-1 flex items-center gap-1.5 self-start text-[12px] font-medium text-muted transition-colors hover:text-ink"
      >
        {advanced ? "Hide" : "Show"} advanced settings
      </button>

      {advanced ? (
        <div className="flex flex-col gap-5 rounded-xl border border-line bg-surface2/40 p-4">
          {model === "chatterbox" ? (
            <>
              <Slider
                label="Adherence to voice"
                value={params.cfg}
                min={0.2}
                max={1}
                step={0.05}
                disabled={running}
                onChange={(v) => setParams({ cfg: v })}
              />
              <Slider
                label="Variation"
                value={params.temperature}
                min={0.5}
                max={1}
                step={0.05}
                disabled={running}
                onChange={(v) => setParams({ temperature: v })}
              />
            </>
          ) : null}
          <div>
            <FieldLabel>Seed</FieldLabel>
            <div className="flex gap-2">
              <Input
                type="number"
                className="font-mono tabular-nums"
                value={params.seed}
                disabled={running}
                onChange={(e) => setParams({ seed: Math.floor(Number(e.target.value)) || 0 })}
              />
              <Button
                aria-label="Randomize seed"
                disabled={running}
                onClick={() => setParams({ seed: Math.floor(Math.random() * 1_000_000) })}
              >
                <IconSparkle className="h-4 w-4" />
              </Button>
            </div>
            <p className="mt-1.5 text-[11.5px] text-faint">
              Same seed + same text = same audio, every time.
            </p>
          </div>
        </div>
      ) : null}

      <Button
        disabled={running || !connected || !hasVoice || !hasChunks || modelsLoaded.length < 2}
        onClick={() => setAbOpen(true)}
        title={
          modelsLoaded.length < 2 && connected
            ? "Both models need to be loaded on the GPU"
            : undefined
        }
      >
        A/B compare a chunk
      </Button>
      <AbCompareDialog open={abOpen} onClose={() => setAbOpen(false)} />
    </div>
  );
}
