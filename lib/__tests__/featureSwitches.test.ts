import { describe, expect, it } from "vitest";
import { backendPatchSchema } from "../server/backendPatch";
import { backendFeatures } from "../server/backends";
import { pickClipBackends } from "../server/clipjobs";
import { pickPresenterBackends } from "../server/presenters";
import type { BackendProvider, BackendView } from "../types";

/**
 * Admin → Backends has three switches per backend: Voice, Presenter and AI
 * video. Each keeps that backend out of one kind of work and nothing else, so
 * Modal (paid) can be kept out of any feature while Colab and Kaggle still
 * come first for everything.
 */

function backend(provider: BackendProvider, patch: Partial<BackendView> = {}): BackendView {
  return {
    provider,
    url: provider === "modal" ? "https://ws--voiceforge-api.modal.run" : `https://${provider}.trycloudflare.com`,
    models: ["chatterbox"],
    registeredAt: 0,
    lastHeartbeat: 0,
    enabled: true,
    priority: 1,
    health: "online",
    secondsSinceHeartbeat: 0,
    secondsSinceReached: 0,
    capabilities: ["tts", "presenter-relip"],
    wanUrl: `https://${provider}.example/wan`,
    wanCapabilities: ["text-to-video"],
    ...patch,
  };
}

describe("backendFeatures", () => {
  it("treats absent switches as on, so existing rows need no migration", () => {
    expect(backendFeatures({})).toEqual({ voice: true, presenter: true, clips: true });
  });

  it("reads each switch on its own", () => {
    expect(backendFeatures({ voiceEnabled: false })).toEqual({ voice: false, presenter: true, clips: true });
    expect(backendFeatures({ videoEnabled: false })).toEqual({ voice: true, presenter: false, clips: true });
    expect(backendFeatures({ clipsEnabled: false })).toEqual({ voice: true, presenter: true, clips: false });
  });
});

describe("the AI video switch", () => {
  it("keeps Modal out of clips while the free notebooks still take them", () => {
    const all = [backend("colab"), backend("kaggle"), backend("modal", { clipsEnabled: false })];
    expect(pickClipBackends(all).map((b) => b.provider)).toEqual(["colab", "kaggle"]);
  });

  it("is independent of the Presenter switch", () => {
    const modalNoPresenter = backend("modal", { videoEnabled: false });
    expect(pickClipBackends([modalNoPresenter]).map((b) => b.provider)).toEqual(["modal"]);
    expect(pickPresenterBackends([modalNoPresenter], "recording")).toEqual([]);

    const modalNoClips = backend("modal", { clipsEnabled: false });
    expect(pickClipBackends([modalNoClips])).toEqual([]);
    expect(pickPresenterBackends([modalNoClips], "recording").map((b) => b.provider)).toEqual(["modal"]);
  });
});

describe("the switches in the backends API", () => {
  it("accepts each switch alone or together", () => {
    expect(backendPatchSchema.parse({ provider: "modal", voiceEnabled: false })).toEqual({
      provider: "modal",
      voiceEnabled: false,
    });
    expect(backendPatchSchema.parse({ provider: "kaggle", clipsEnabled: true, videoEnabled: false })).toEqual({
      provider: "kaggle",
      clipsEnabled: true,
      videoEnabled: false,
    });
  });

  it("refuses a non-boolean rather than guessing", () => {
    expect(() => backendPatchSchema.parse({ provider: "modal", clipsEnabled: "off" })).toThrow();
  });
});
