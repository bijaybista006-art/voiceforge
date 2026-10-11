"use client";

import Link from "next/link";
import { usePresenterStatus } from "@/lib/presenterClient";
import type { PresenterKind } from "@/lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card, CardHeader } from "../ui/Card";
import { IconImage, IconRefresh, IconVideo } from "../ui/Icons";

const KIND_LABEL: Record<PresenterKind, { title: string; how: string }> = {
  recording: {
    title: "From a recording",
    how: "A short video of the presenter. Only the mouth is redrawn to match each new line, so everything else stays real footage.",
  },
  image: {
    title: "From a still image",
    how: "One picture, animated from nothing. Use it for an illustrated or AI-generated presenter. Needs a much larger GPU.",
  },
};

/**
 * Presenter video in the studio.
 *
 * This replaced the old talking-head page, which had its own notebook, its
 * own pasted tunnel URL and its own copy of the photo in the browser. None of
 * that exists now: presenters live in the central library, and a clip renders
 * on whichever registered backend reports the engine — the same rule voice
 * follows. So this page shows the library and says plainly what can and
 * cannot be rendered at the moment.
 */
export function VideoView() {
  const { status, failed, reload } = usePresenterStatus();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
            Presenter Video
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Lip-synced intro and outro clips, spoken in your cloned voice by a presenter you choose.
            The slideshow render in between is unchanged.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={reload}>
            <IconRefresh className="h-3.5 w-3.5" />
            Refresh
          </Button>
          <Link
            href="/admin/presenters"
            className="inline-flex h-9 items-center rounded-xl bg-video px-4 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
          >
            Manage presenters
          </Link>
        </div>
      </header>

      {failed ? (
        <Card>
          <p className="text-sm text-muted">
            Couldn&apos;t load the presenter library. Check that you&apos;re signed in, then
            refresh.
          </p>
        </Card>
      ) : !status ? (
        <Card>
          <p className="text-sm text-muted">Loading…</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {status.hint ? (
            <Card>
              <p className="text-sm text-ink">
                <strong>Storage isn&apos;t ready.</strong> {status.hint}
              </p>
            </Card>
          ) : null}

          <section className="grid gap-4 md:grid-cols-2" aria-label="What can be rendered">
            {(Object.keys(KIND_LABEL) as PresenterKind[]).map((kind) => {
              const r = status.readiness[kind];
              return (
                <Card key={kind} accent="video">
                  <CardHeader
                    accent="video"
                    icon={
                      kind === "recording" ? (
                        <IconVideo className="h-[18px] w-[18px]" />
                      ) : (
                        <IconImage className="h-[18px] w-[18px]" />
                      )
                    }
                    title={KIND_LABEL[kind].title}
                    description={KIND_LABEL[kind].how}
                    action={
                      <Badge tone={r.ready ? "video" : "neutral"} dot>
                        {r.ready ? `Ready on ${r.provider}` : "Not available"}
                      </Badge>
                    }
                  />
                  {!r.ready ? (
                    <p className="text-[12.5px] leading-relaxed text-muted">{r.reason}</p>
                  ) : null}
                </Card>
              );
            })}
          </section>

          <Card>
            <CardHeader
              title="Your presenters"
              description="The default is used unless a workflow names another one for that video."
            />
            {status.presenters.length === 0 ? (
              <p className="text-sm text-muted">
                None yet. Add a short recording of yourself or a still image in{" "}
                <Link href="/admin/presenters" className="text-video underline">
                  Admin → Presenters
                </Link>
                .
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {status.presenters.map((p) => (
                  <div key={p.id} className="overflow-hidden rounded-xl border border-line">
                    <div className="grid aspect-video place-items-center bg-surface3">
                      {p.kind === "recording" ? (
                        <video
                          src={p.url}
                          controls
                          preload="metadata"
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.url} alt={p.name} className="h-full w-full object-contain" />
                      )}
                    </div>
                    <div className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-[13.5px] font-medium text-ink">{p.name}</p>
                        {p.isDefault ? (
                          <Badge tone="video">default</Badge>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-[12px] text-muted">
                        {p.kind === "recording" ? "Recording" : "Still image"}
                        {p.durationSec ? ` · ${p.durationSec.toFixed(1)}s` : ""}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
