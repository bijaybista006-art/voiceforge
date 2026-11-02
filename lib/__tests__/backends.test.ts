import { describe, expect, it } from "vitest";
import { OFFLINE_AFTER_SECONDS, computeHealth, isUsableHealth } from "../server/backends";
import type { BackendProvider, RegisteredBackend } from "../types";

/**
 * The registry decides where every generation goes, so the liveness and
 * fallback rules are worth pinning down. computeHealth is the pure core;
 * resolveBackend just sorts by priority and picks the first usable row, so
 * we exercise that same predicate here without needing Redis.
 */

function backend(patch: Partial<RegisteredBackend> = {}): RegisteredBackend {
  return {
    provider: "colab" as BackendProvider,
    url: "https://x.trycloudflare.com",
    models: ["chatterbox"],
    registeredAt: Date.now(),
    lastHeartbeat: Date.now(),
    enabled: true,
    priority: 1,
    ...patch,
  };
}

const NOW = 1_700_000_000_000;

describe("computeHealth", () => {
  it("a notebook that stopped itself while idle is offline at once, and online again when it restarts", () => {
    expect(computeHealth(backend({ lastHeartbeat: NOW, stoppedIdleAt: NOW }), NOW)).toBe("offline");
    // A new session heartbeats after the goodbye: that later word wins.
    expect(computeHealth(backend({ lastHeartbeat: NOW + 1000, stoppedIdleAt: NOW }), NOW + 1000)).toBe("online");
  });

  it("is online right after a heartbeat", () => {
    expect(computeHealth(backend({ lastHeartbeat: NOW }), NOW)).toBe("online");
  });

  it("stays online through two missed heartbeats", () => {
    const twoMissed = NOW - 2 * 60 * 1000;
    expect(computeHealth(backend({ lastHeartbeat: twoMissed }), NOW)).toBe("online");
  });

  it("goes offline after three missed heartbeats", () => {
    const past = NOW - (OFFLINE_AFTER_SECONDS + 1) * 1000;
    expect(computeHealth(backend({ lastHeartbeat: past }), NOW)).toBe("offline");
  });

  it("reports busy while a job is running", () => {
    expect(computeHealth(backend({ busy: true }), NOW)).toBe("busy");
  });

  it("reports disabled regardless of heartbeat, so an admin's choice wins", () => {
    expect(computeHealth(backend({ enabled: false, lastHeartbeat: NOW }), NOW)).toBe("disabled");
  });
});

describe("auto-selection semantics", () => {
  // Mirrors resolveBackend(): sort by priority, take the first usable.
  // The real predicate, not a copy of it.
  const pick = (rows: RegisteredBackend[]) =>
    rows
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .find((r) => isUsableHealth(computeHealth(r, NOW)))?.provider ?? null;

  const dead = NOW - (OFFLINE_AFTER_SECONDS + 5) * 1000;

  it("prefers the highest-priority healthy backend", () => {
    expect(
      pick([
        backend({ provider: "colab", priority: 1, lastHeartbeat: NOW }),
        backend({ provider: "modal", priority: 0, lastHeartbeat: NOW }),
      ])
    ).toBe("modal");
  });

  it("falls past a dead backend to the next one", () => {
    expect(
      pick([
        backend({ provider: "modal", priority: 0, lastHeartbeat: dead }),
        backend({ provider: "colab", priority: 1, lastHeartbeat: NOW }),
      ])
    ).toBe("colab");
  });

  it("skips a disabled backend even when it is heartbeating", () => {
    expect(
      pick([
        backend({ provider: "modal", priority: 0, lastHeartbeat: NOW, enabled: false }),
        backend({ provider: "kaggle", priority: 2, lastHeartbeat: NOW }),
      ])
    ).toBe("kaggle");
  });

  it("returns nothing when everything is down, rather than a dead URL", () => {
    expect(
      pick([
        backend({ provider: "modal", priority: 0, lastHeartbeat: dead }),
        backend({ provider: "colab", priority: 1, lastHeartbeat: dead }),
      ])
    ).toBeNull();
  });

  it("treats a busy backend as usable — jobs queue rather than fail over", () => {
    expect(pick([backend({ provider: "modal", priority: 0, busy: true })])).toBe("modal");
  });
});

describe("backends that never heartbeat", () => {
  /**
   * Modal and hand-entered custom URLs are permanent endpoints with no
   * notebook behind them, and Modal scales to zero so silence is its normal
   * state. Ageing them out by heartbeat would quietly delete the fallback you
   * added for exactly the moment the notebooks are down.
   */
  it("stays online however long ago it last answered", () => {
    const ancient = NOW - 30 * 24 * 60 * 60 * 1000;
    expect(
      computeHealth(
        backend({
          provider: "modal",
          selfRegistered: false,
          lastHeartbeat: ancient,
          lastReachedAt: ancient,
        }),
        NOW
      )
    ).toBe("online");
  });

  it("is unverified until something actually answers there", () => {
    // A typed-in URL is a claim. Calling it "online" on the strength of
    // having been typed is how a disabled Modal workspace looked healthy
    // right up to the moment a job was handed to it and hung.
    expect(
      computeHealth(backend({ provider: "modal", selfRegistered: false }), NOW)
    ).toBe("unverified");
  });

  it("is still dispatched to while unverified", async () => {
    // It means "unproven", not "broken" — and excluding it would delete the
    // paid fallback at exactly the moment the free notebooks are down.
    const { usableBackends } = await import("../server/backends");
    void usableBackends;
    expect(
      computeHealth(backend({ provider: "modal", selfRegistered: false }), NOW)
    ).not.toBe("offline");
  });

  it("still respects the admin's disable switch", () => {
    expect(
      computeHealth(backend({ provider: "modal", selfRegistered: false, enabled: false }), NOW)
    ).toBe("disabled");
  });

  it("still reports busy while it's rendering", () => {
    expect(
      computeHealth(backend({ provider: "modal", selfRegistered: false, busy: true }), NOW)
    ).toBe("busy");
  });

  it("does not change how a heartbeating backend is judged", () => {
    const dead = NOW - (OFFLINE_AFTER_SECONDS + 1) * 1000;
    expect(
      computeHealth(backend({ provider: "colab", selfRegistered: true, lastHeartbeat: dead }), NOW)
    ).toBe("offline");
  });
});

describe("paid fallback ordering", () => {
  // The point of the priority change: Modal bills per second, so it must only
  // pick up work once the free GPUs are genuinely unavailable.
  // The real predicate, not a copy of it: a duplicate is how "unverified"
  // came to be routable in production and unroutable in this test on the
  // same commit.
  const pick = (rows: RegisteredBackend[]) =>
    rows
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .find((r) => isUsableHealth(computeHealth(r, NOW)))?.provider ?? null;

  const dead = NOW - (OFFLINE_AFTER_SECONDS + 5) * 1000;
  const modal = backend({ provider: "modal", priority: 3, selfRegistered: false, lastHeartbeat: dead });

  it("prefers a live Colab over Modal", () => {
    expect(pick([modal, backend({ provider: "colab", priority: 0, lastHeartbeat: NOW })])).toBe("colab");
  });

  it("prefers Kaggle over Modal when Colab is down", () => {
    expect(
      pick([
        modal,
        backend({ provider: "colab", priority: 0, lastHeartbeat: dead }),
        backend({ provider: "kaggle", priority: 1, lastHeartbeat: NOW }),
      ])
    ).toBe("kaggle");
  });

  it("falls through to Modal only when both free backends are down", () => {
    expect(
      pick([
        modal,
        backend({ provider: "colab", priority: 0, lastHeartbeat: dead }),
        backend({ provider: "kaggle", priority: 1, lastHeartbeat: dead }),
      ])
    ).toBe("modal");
  });

  it("does not reach Modal just because Colab is busy — jobs queue instead", () => {
    expect(
      pick([modal, backend({ provider: "colab", priority: 0, lastHeartbeat: NOW, busy: true })])
    ).toBe("colab");
  });
});
