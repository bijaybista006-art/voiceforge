"use client";

import { useApp } from "@/lib/store";
import { ChunkList } from "../ChunkList";
import { ExportBar } from "../ExportBar";
import { ModelControls } from "../ModelControls";
import { ScriptEditor } from "../ScriptEditor";
import { VoiceLab } from "../VoiceLab";
import { GpuOfflineNotice } from "../studio/GpuOfflineNotice";
import { Card, CardHeader } from "../ui/Card";
import { IconMic, IconScript, IconSparkle } from "../ui/Icons";
import { Disclosure, PageHeader } from "../ui/Kit";

/**
 * Text to Speech: a focused tool. Script in, choose a voice, Generate, then
 * listen and download. Model and delivery settings live under Advanced,
 * closed by default. The generation queue itself lives in the store, so it
 * keeps running while you visit other studio pages.
 */
export function SpeechView() {
  const connected = useApp((s) => s.backend.connected);
  const hydrated = useApp((s) => s.hydrated);

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-8 sm:px-6 lg:py-10">
      <PageHeader
        title="Text to Speech"
        description="Paste a script, pick a voice, and generate narration. Long scripts are split into short pieces and saved as they finish, so nothing is lost if the connection drops."
      />

      {hydrated && !connected ? (
        <div className="mb-6">
          <GpuOfflineNotice what="generate narration" />
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* ---------- input and generation ---------- */}
        <div className="flex min-w-0 flex-col gap-5">
          <Card>
            <CardHeader
              accent="audio"
              icon={<IconScript className="h-[18px] w-[18px]" />}
              title="1 · Your script"
              description="Paste your narration, or drop in a .txt or .md file."
            />
            <ScriptEditor />
          </Card>

          <Card>
            <CardHeader
              accent="audio"
              icon={<IconSparkle className="h-[18px] w-[18px]" />}
              title="3 · Generate and listen"
              description="Generates one piece at a time and shows the time left. Play, redo or edit any piece."
            />
            <ChunkList />
          </Card>
        </div>

        {/* ---------- voice, settings, download ---------- */}
        <aside className="flex min-w-0 flex-col gap-5" aria-label="Voice and settings">
          <Card>
            <CardHeader
              accent="audio"
              icon={<IconMic className="h-[18px] w-[18px]" />}
              title="2 · Voice"
              description="Choose a saved voice, or add your own from a short recording."
            />
            <VoiceLab />
          </Card>

          <Disclosure
            title="Advanced settings"
            hint="Model, language and delivery. The defaults suit most narration."
            className="bg-surface shadow-card"
          >
            <ModelControls />
          </Disclosure>

          <ExportBar />
        </aside>
      </div>
    </div>
  );
}
