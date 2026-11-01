import { describe, expect, it } from "vitest";
import { lipSyncMinutesLeft, lipSyncStep } from "@/lib/presenterProgress";

describe("presenter progress", () => {
  it("names the engine's step from the number", () => {
    expect(lipSyncStep(15)).toBe("Starting the lip-sync engine");
    expect(lipSyncStep(20)).toBe("Finding the face in each frame");
    expect(lipSyncStep(50)).toBe("Redrawing the mouth");
    expect(lipSyncStep(90)).toBe("Putting the face back into each frame");
    expect(lipSyncStep(null)).toBe("Starting the lip-sync engine");
  });

  it("waits for enough movement before estimating", () => {
    expect(lipSyncMinutesLeft(null, { at: 1, progress: 50 })).toBeNull();
    expect(lipSyncMinutesLeft({ at: 0, progress: 20 }, { at: 120_000, progress: 21 })).toBeNull();
    expect(lipSyncMinutesLeft({ at: 0, progress: 20 }, { at: 10_000, progress: 40 })).toBeNull();
  });

  it("extrapolates from the observed rate and never says zero", () => {
    // 10 points in 5 minutes, 44 to go: 22 minutes.
    expect(lipSyncMinutesLeft({ at: 0, progress: 40 }, { at: 300_000, progress: 50 })).toBe(22);
    expect(lipSyncMinutesLeft({ at: 0, progress: 80 }, { at: 600_000, progress: 93 })).toBe(1);
  });
});
