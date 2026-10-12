import { describe, expect, it } from "vitest";
import { backendPatchSchema } from "../server/backendPatch";
import {
  MAX_IMAGE_BYTES,
  MAX_RECORDING_BYTES,
  PresenterError,
  assertOurPresenterUrl,
  assertPresenterFile,
  isPresenterKind,
  isPresenterSource,
  pickPresenterBackends,
  presenterCapability,
  presenterReadiness,
  slugifyPresenterName,
} from "../server/presenters";
import {
  installNote,
  presenterCandidateUrl,
  presenterUrlOf,
  shouldProbePresenter,
} from "../server/presenterjobs";
import type { BackendProvider, BackendView } from "../types";

/**
 * Presenters put a face on a video, so the rules worth pinning are the ones
 * that decide what may be stored and where it may be rendered: what a file is
 * allowed to be, that a row can only point at our own storage, and that the
 * per-backend video switch really does keep a backend out of video work.
 */

function backend(provider: BackendProvider, patch: Partial<BackendView> = {}): BackendView {
  return {
    provider,
    url: `https://${provider}.test`,
    models: ["chatterbox"],
    registeredAt: 0,
    lastHeartbeat: 0,
    enabled: true,
    priority: 0,
    health: "online",
    secondsSinceHeartbeat: 1,
    secondsSinceReached: null,
    capabilities: ["tts"],
    ...patch,
  };
}

describe("kinds and sources", () => {
  it("knows the two kinds and nothing else", () => {
    expect(isPresenterKind("recording")).toBe(true);
    expect(isPresenterKind("image")).toBe(true);
    expect(isPresenterKind("video")).toBe(false);
  });

  it("knows whose face it can be", () => {
    for (const s of ["self", "generated", "permission"]) expect(isPresenterSource(s)).toBe(true);
    expect(isPresenterSource("celebrity")).toBe(false);
  });

  it("makes readable ids", () => {
    expect(slugifyPresenterName("Bijay — Office.mp4")).toBe("bijay-office");
    expect(slugifyPresenterName("???")).toBe("presenter");
  });
});

describe("assertPresenterFile", () => {
  it("accepts what a phone or a camera produces", () => {
    expect(() => assertPresenterFile("recording", "video/mp4", 8_000_000, 15)).not.toThrow();
    expect(() => assertPresenterFile("recording", "video/quicktime", 8_000_000, 15)).not.toThrow();
    expect(() => assertPresenterFile("image", "image/jpeg", 500_000)).not.toThrow();
  });

  it("rejects a recording that is really an image, and the reverse", () => {
    expect(() => assertPresenterFile("recording", "image/png", 1000)).toThrow(PresenterError);
    expect(() => assertPresenterFile("image", "video/mp4", 1000)).toThrow(/PNG, JPEG or WebP/);
  });

  it("rejects SVG, which nothing downstream can read", () => {
    expect(() => assertPresenterFile("image", "image/svg+xml", 1000)).toThrow();
  });

  it("holds each kind to its own size limit", () => {
    expect(() => assertPresenterFile("recording", "video/mp4", MAX_RECORDING_BYTES + 1, 15)).toThrow(
      /over 50 MB/
    );
    expect(() => assertPresenterFile("image", "image/png", MAX_IMAGE_BYTES + 1)).toThrow(
      /over 10 MB/
    );
  });

  it("rejects a recording too short to hold natural movement, or far too long", () => {
    expect(() => assertPresenterFile("recording", "video/mp4", 1000, 2)).toThrow(/at least 5s/);
    expect(() => assertPresenterFile("recording", "video/mp4", 1000, 300)).toThrow(/Trim it/);
  });

  it("does not block an upload whose length the browser could not read", () => {
    expect(() => assertPresenterFile("recording", "video/mp4", 1000)).not.toThrow();
  });
});

describe("assertOurPresenterUrl", () => {
  // "Our store" is whichever Supabase project the server is pointed at.
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  const ok = "https://proj.supabase.co/storage/v1/object/public/voiceforge-audio/presenters/recording/1-me.mp4";

  it("accepts a file in our store under the right kind", () => {
    expect(() => assertOurPresenterUrl(ok, "recording")).not.toThrow();
  });

  it("refuses a file hosted anywhere else", () => {
    expect(() =>
      assertOurPresenterUrl("https://evil.example.com/presenters/recording/x.mp4", "recording")
    ).toThrow(/this project.s storage/);
  });

  it("refuses a file stored under the other kind", () => {
    expect(() => assertOurPresenterUrl(ok, "image")).toThrow(/presenter kind/);
  });

  it("refuses plain http and nonsense", () => {
    expect(() =>
      assertOurPresenterUrl(ok.replace("https://", "http://"), "recording")
    ).toThrow();
    expect(() => assertOurPresenterUrl("not a url", "recording")).toThrow(/valid URL/);
  });
});

describe("routing", () => {
  it("asks for a different capability per kind", () => {
    expect(presenterCapability("recording")).toBe("presenter-relip");
    expect(presenterCapability("image")).toBe("presenter-animate");
  });

  it("never sends video to a backend that only does voice", () => {
    const all = [backend("colab"), backend("kaggle"), backend("modal")];
    expect(pickPresenterBackends(all, "recording")).toEqual([]);
  });

  it("keeps the standard order among backends that can do it", () => {
    const all = [
      backend("colab", { capabilities: ["tts", "presenter-relip"] }),
      backend("kaggle", { capabilities: ["tts"] }),
      backend("modal", { capabilities: ["tts", "presenter-relip", "presenter-animate"] }),
    ];
    expect(pickPresenterBackends(all, "recording").map((b) => b.provider)).toEqual([
      "colab",
      "modal",
    ]);
    // Only Modal has the larger engine a still image needs.
    expect(pickPresenterBackends(all, "image").map((b) => b.provider)).toEqual(["modal"]);
  });

  it("honours the video switch without touching the backend's other work", () => {
    const colab = backend("colab", {
      capabilities: ["tts", "presenter-relip"],
      videoEnabled: false,
    });
    const modal = backend("modal", { capabilities: ["tts", "presenter-relip"] });
    expect(pickPresenterBackends([colab, modal], "recording").map((b) => b.provider)).toEqual([
      "modal",
    ]);
    // Still enabled and online as a backend: the switch is video-only.
    expect(colab.enabled).toBe(true);
    expect(colab.health).toBe("online");
  });

  it("treats an absent switch as on, so existing backends need no migration", () => {
    const b = backend("modal", { capabilities: ["presenter-relip"] });
    expect(b.videoEnabled).toBeUndefined();
    expect(pickPresenterBackends([b], "recording")).toHaveLength(1);
  });

  it("skips a backend that is offline or disabled", () => {
    const all = [
      backend("colab", { capabilities: ["presenter-relip"], health: "offline" }),
      backend("kaggle", { capabilities: ["presenter-relip"], health: "disabled" }),
    ];
    expect(pickPresenterBackends(all, "recording")).toEqual([]);
  });
});

describe("presenterReadiness", () => {
  it("names the backend that would take the job", () => {
    const r = presenterReadiness(
      [backend("modal", { capabilities: ["presenter-animate"] })],
      "image"
    );
    expect(r).toEqual({ ready: true, provider: "modal" });
  });

  it("says when nothing connected has the engine at all", () => {
    const r = presenterReadiness([backend("colab"), backend("modal")], "image");
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/No connected backend can animate a still image/);
  });

  it("says when the only capable backend has video switched off", () => {
    const r = presenterReadiness(
      [backend("modal", { capabilities: ["presenter-animate"], videoEnabled: false })],
      "image"
    );
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/switched off/);
    expect(r.reason).toMatch(/Admin → Backends/);
  });

  it("says when a capable backend is simply not online", () => {
    const r = presenterReadiness(
      [backend("kaggle", { capabilities: ["presenter-relip"], health: "offline" })],
      "recording"
    );
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/not online/);
  });
});

describe("the video switch in the backends API", () => {
  it("is accepted alongside the other per-backend settings", () => {
    const parsed = backendPatchSchema.parse({ provider: "colab", videoEnabled: false });
    expect(parsed).toEqual({ provider: "colab", videoEnabled: false });
  });

  it("does not disturb adding a backend by URL", () => {
    const parsed = backendPatchSchema.parse({ provider: "modal", url: "https://x.modal.run" });
    expect(parsed).toEqual({ provider: "modal", url: "https://x.modal.run" });
  });
});

describe("where presenter work is sent", () => {
  it("derives Modal's presenter function from its voice function", () => {
    expect(presenterCandidateUrl("https://me--voiceforge-api.modal.run")).toBe(
      "https://me--voiceforge-presenter.modal.run"
    );
    expect(presenterCandidateUrl("https://me--voiceforge-api.modal.run/")).toBe(
      "https://me--voiceforge-presenter.modal.run"
    );
  });

  it("has nothing to derive for a notebook tunnel, which serves everything itself", () => {
    expect(presenterCandidateUrl("https://abc.trycloudflare.com")).toBeNull();
  });

  it("uses the dedicated address when there is one, otherwise the main one", () => {
    expect(presenterUrlOf({ url: "https://a.test/", presenterUrl: "https://p.test/" })).toBe(
      "https://p.test"
    );
    expect(presenterUrlOf({ url: "https://a.test/" })).toBe("https://a.test");
  });

  it("routes on what the presenter address reported, not only the voice server", () => {
    // Modal's voice /health says ["tts"]; the presenter function is what
    // knows it can lip-sync. Losing that on the next voice probe would
    // silently take Modal out of video routing.
    const modal = backend("modal", {
      capabilities: ["tts"],
      presenterCapabilities: ["presenter-relip"],
    });
    expect(pickPresenterBackends([modal], "recording")).toHaveLength(1);
    expect(pickPresenterBackends([modal], "image")).toHaveLength(0);
    expect(presenterReadiness([modal], "recording")).toEqual({ ready: true, provider: "modal" });
  });
});

describe("finding a notebook's presenter service", () => {
  it("looks under /presenter on the notebook's own tunnel", () => {
    expect(presenterCandidateUrl("https://abc.trycloudflare.com", true)).toBe(
      "https://abc.trycloudflare.com/presenter"
    );
  });

  it("asks an address it has never asked", () => {
    expect(shouldProbePresenter({ url: "https://abc.trycloudflare.com", selfRegistered: true })).toBe(
      true
    );
  });

  it("stops asking once the engine is there", () => {
    expect(
      shouldProbePresenter({
        url: "https://abc.trycloudflare.com",
        selfRegistered: true,
        presenterProbedUrl: "https://abc.trycloudflare.com/presenter",
        presenterProbedAt: 0,
        presenterCapabilities: ["presenter-relip"],
      })
    ).toBe(false);
  });

  it("asks again after a pause while the engine is still installing", () => {
    const row = {
      url: "https://abc.trycloudflare.com",
      selfRegistered: true,
      presenterProbedUrl: "https://abc.trycloudflare.com/presenter",
      presenterProbedAt: 1_000_000,
      presenterCapabilities: [],
    };
    expect(shouldProbePresenter(row, 1_000_000 + 30_000)).toBe(false);
    expect(shouldProbePresenter(row, 1_000_000 + 120_000)).toBe(true);
  });

  it("asks again when a new session gives the notebook a new address", () => {
    expect(
      shouldProbePresenter({
        url: "https://new.trycloudflare.com",
        selfRegistered: true,
        presenterProbedUrl: "https://old.trycloudflare.com/presenter",
        presenterProbedAt: Date.now(),
        presenterCapabilities: ["presenter-relip"],
      })
    ).toBe(true);
  });

  it("never asks a hand-added address that has no presenter service to find", () => {
    expect(shouldProbePresenter({ url: "https://my.server.example", selfRegistered: false })).toBe(
      false
    );
  });
});

describe("what a notebook says about its engine install", () => {
  it("is silent once the engine is ready", () => {
    expect(installNote({ state: "ready", stage: "ready" })).toBeUndefined();
    expect(installNote(undefined)).toBeUndefined();
  });

  it("names the step it is on while installing", () => {
    expect(installNote({ state: "installing", stage: "downloading the weights" })).toBe(
      "it is still installing its engine (downloading the weights)"
    );
  });

  it("carries the reason when the install failed", () => {
    expect(installNote({ state: "failed", error: "no space left on device" })).toMatch(
      /failed to install: no space left on device/
    );
  });

  it("is shown on the Presenters page instead of a bare 'not yet'", () => {
    const kaggle = backend("kaggle", {
      presenterNote: "it is still installing its engine (downloading the weights)",
    });
    const r = presenterReadiness([kaggle], "recording");
    expect(r.ready).toBe(false);
    expect(r.reason).toBe(
      "Not ready yet — kaggle: it is still installing its engine (downloading the weights)."
    );
  });
});
