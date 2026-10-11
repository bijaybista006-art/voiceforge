"use client";

import { useApp } from "@/lib/store";
import { ChunkList } from "../ChunkList";
import { EngineStatusBar, SpeechConnectionForm } from "../Connections";
import { ExportBar } from "../ExportBar";
import { ModelControls } from "../ModelControls";
import { ScriptEditor } from "../ScriptEditor";
import { VoiceLab } from "../VoiceLab";
import { Card, CardHeader } from "../ui/Card";
import { IconMic, IconScript, IconSettings, IconSparkle, IconWave } from "../ui/Icons";

export function SpeechView() {
  const connected = useApp((s) => s.backend.connected);

  return (
    <div className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 lg:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
            Text to Speech
          </h1>
          <p className="mt-1 text-sm text-muted">
            Clone a voice, paste a script, and generate narration chunk by chunk.
          </p>
        </div>
        <EngineStatusBar />
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* main column */}
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader
              accent="audio"
              icon={<IconScript className="h-[18px] w-[18px]" />}
              title="Script"
              description="Paste your narration, or drop in a .txt / .md file. It's split into chunks automatically."
            />
            <ScriptEditor />
          </Card>

          <Card>
            <CardHeader
              accent="audio"
              icon={<IconSparkle className="h-[18px] w-[18px]" />}
              title="Generation"
              description="Runs one chunk at a time. Every finished chunk is saved instantly — a disconnect loses nothing."
            />
            <ChunkList />
          </Card>
        </div>

        {/* settings rail */}
        <aside className="flex min-w-0 flex-col gap-4">
          {/* Mirrors the Video view: the connection card sits at the top of the
              rail while the GPU is offline, and gets out of the way once live. */}
          {!connected ? (
            <Card>
              <CardHeader
                accent="audio"
                icon={<IconWave className="h-[18px] w-[18px]" />}
                title="Start the speech GPU"
                description="Run the notebook on Colab or Kaggle with a T4 GPU. It registers itself — nothing to paste."
              />
              <SpeechConnectionForm />
            </Card>
          ) : null}

          <Card>
            <CardHeader
              accent="audio"
              icon={<IconMic className="h-[18px] w-[18px]" />}
              title="Voice"
              description="Saved to your library, then cached on whichever GPU is running."
            />
            <VoiceLab />
          </Card>

          <Card>
            <CardHeader
              icon={<IconSettings className="h-[18px] w-[18px]" />}
              title="Model & delivery"
              description="Sensible defaults for narration — adjust only if you need to."
            />
            <ModelControls />
          </Card>

          <ExportBar />
        </aside>
      </div>
    </div>
  );
}
