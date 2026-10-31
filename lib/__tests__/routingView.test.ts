import { describe, expect, it } from "vitest";
import { isUsableHealth } from "../server/backends";
import { pickClipBackends } from "../server/clipjobs";
import { pickPresenterBackends } from "../server/presenters";
import { ROUTING_ORDER, servingClips, servingPresenter, servingVoice, usableHealth } from "../routingView";
import type { BackendHealthKind, BackendProvider, BackendView } from "../types";

/**
 * The admin pages show "serving now" with a browser-safe copy of the routing
 * rule. These tests hold that copy to the server's real predicates, so the
 * dashboard can never claim a backend the server would not use.
 */

function backend(provider: BackendProvider, patch: Partial<BackendView> = {}): BackendView {
  return {
    provider,
    url: `https://${provider}.example`,
    models: ["chatterbox"],
    registeredAt: 0,
    lastHeartbeat: 0,
    enabled: true,
    priority: 0,
    health: "online",
    secondsSinceHeartbeat: 0,
    secondsSinceReached: 0,
    capabilities: ["tts", "presenter-relip"],
    wanUrl: `https://${provider}.example/wan`,
    wanCapabilities: ["text-to-video"],
    ...patch,
  };
}

const HEALTHS: BackendHealthKind[] = ["online", "busy", "offline", "disabled", "unverified"];

describe("routingView mirrors the server", () => {
  it("uses the same usable-health rule", () => {
    for (const h of HEALTHS) expect(usableHealth(h)).toBe(isUsableHealth(h));
  });

  it("walks the fixed order Colab, Kaggle, Custom, Modal", () => {
    expect(ROUTING_ORDER).toEqual(["colab", "kaggle", "custom", "modal"]);
    const rows = [backend("modal"), backend("kaggle"), backend("colab")];
    expect(servingVoice(rows)?.provider).toBe("colab");
  });

  it("skips offline, disabled and voice-off backends for voice", () => {
    const rows = [
      backend("colab", { health: "offline" }),
      backend("kaggle", { voiceEnabled: false }),
      backend("custom", { health: "disabled" }),
      backend("modal"),
    ];
    expect(servingVoice(rows)?.provider).toBe("modal");
    expect(servingVoice([backend("colab", { health: "offline" })])).toBeNull();
  });

  it("agrees with pickPresenterBackends for every switch and health", () => {
    for (const h of HEALTHS) {
      for (const videoEnabled of [true, false, undefined]) {
        const rows = [backend("kaggle", { health: h, videoEnabled }), backend("modal", { capabilities: ["tts"] })];
        expect(servingPresenter(rows)?.provider ?? null).toBe(pickPresenterBackends(rows, "recording")[0]?.provider ?? null);
      }
    }
  });

  it("agrees with pickClipBackends for every switch and health", () => {
    for (const h of HEALTHS) {
      for (const clipsEnabled of [true, false, undefined]) {
        const rows = [backend("colab", { health: h, clipsEnabled }), backend("modal", { wanCapabilities: [] })];
        expect(servingClips(rows)?.provider ?? null).toBe(pickClipBackends(rows)[0]?.provider ?? null);
      }
    }
  });
});
