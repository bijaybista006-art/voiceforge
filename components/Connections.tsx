"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { HEALTH_POLL_MS } from "@/lib/config";
import { useApp } from "@/lib/store";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { FieldLabel } from "./ui/Card";
import { IconLink, IconWave } from "./ui/Icons";

/**
 * Speech has no URL field any more. Backends register themselves and the
 * server picks one per request, so all this panel does is say which one would
 * answer right now — and point at the admin page when none would.
 */
export function SpeechConnectionForm() {
  const connect = useApp((s) => s.connect);
  const connecting = useApp((s) => s.connecting);
  const backend = useApp((s) => s.backend);

  // A notebook can come up at any time, so keep looking either way.
  useEffect(() => {
    const id = setInterval(() => void connect({ silent: true }), HEALTH_POLL_MS);
    return () => clearInterval(id);
  }, [connect]);

  return (
    <div className="flex flex-col gap-2.5">
      <FieldLabel>Speech engine · chosen in Admin → Backends</FieldLabel>
      {backend.connected ? (
        <p className="font-mono text-[11px] text-muted">
          {backend.url}
          {backend.gpu ? ` · ${backend.gpu}` : ""}
          {backend.modelsLoaded.length ? ` · ${backend.modelsLoaded.join(", ")}` : ""}
        </p>
      ) : (
        <p className="text-[12px] leading-relaxed text-faint">
          Nothing is online. Run <code className="font-mono">voiceforge_server.ipynb</code> on Colab
          or Kaggle with a T4 — it registers itself within a minute.
        </p>
      )}
      <div className="flex gap-2">
        <Button onClick={() => void connect()} disabled={connecting}>
          {connecting ? "Checking…" : "Refresh"}
        </Button>
        <Link
          href="/admin/backends"
          className="inline-flex h-10 items-center rounded-xl border border-line bg-surface px-4 text-sm text-ink transition-colors hover:border-lineStrong"
        >
          Manage backends
        </Link>
      </div>
    </div>
  );
}

/**
 * Explicit, unmissable connection state. The words "Live" / "Offline" carry
 * the meaning — colour and the filled/hollow dot only reinforce it.
 */
export function EngineStatus({ size = "md" }: { size?: "sm" | "md" }) {
  const on = useApp((s) => s.backend.connected);
  const gpu = useApp((s) => s.backend.gpu);

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-lg border font-medium ${
        size === "sm" ? "px-2 py-1 text-[11px]" : "px-2.5 py-1.5 text-[12px]"
      } ${on ? "border-audio/40 bg-audioSoft text-audio" : "border-line bg-surface2 text-muted"}`}
    >
      <span
        aria-hidden
        className={`h-2 w-2 rounded-full ${on ? "bg-audio" : "border border-faint bg-transparent"}`}
      />
      <span>Speech</span>
      <span className={on ? "" : "text-faint"}>{on ? "Live" : "Offline"}</span>
      {on && gpu ? (
        <span className="hidden font-mono text-[10.5px] opacity-70 sm:inline">{gpu}</span>
      ) : null}
    </span>
  );
}

export function ConnectionBadges({ onOpen }: { onOpen(): void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-2 rounded-xl border border-line bg-surface/80 p-1.5 transition-colors hover:border-lineStrong"
      aria-label="Manage GPU connections"
      title="Manage GPU connections"
    >
      <EngineStatus size="sm" />
      <IconLink className="mr-0.5 h-3.5 w-3.5 text-faint" />
    </button>
  );
}

/** Status + a way to fix it, for use in a page header. */
export function EngineStatusBar() {
  const [open, setOpen] = useState(false);
  const on = useApp((s) => s.backend.connected);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <EngineStatus />
        {!on ? (
          <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
            Connect GPU
          </Button>
        ) : null}
      </div>
      <ConnectionsDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function ConnectionsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="GPU connections"
      description="Backends register themselves. Presenter video uses the same ones — switch it on or off per backend in Admin."
    >
      <div className="flex flex-col gap-6">
        <div className="flex gap-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-audioSoft text-audio">
            <IconWave className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <SpeechConnectionForm />
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** Convenience wrapper used by the top bar. */
export function ConnectionsControl() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ConnectionBadges onOpen={() => setOpen(true)} />
      <ConnectionsDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
