import { describe, expect, it, vi } from "vitest";
import { waitForStudioJob } from "../gateway";
import { BackendError } from "../backend";

/**
 * Nepali chunks in the studio run as background jobs and the page follows
 * them here. The point is that a slow chunk — or a notebook still loading the
 * Nepali model — is waited for, instead of being reported as "GPU offline".
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noSleep = async () => {};

function fakeFetch(statuses: Array<Response | Error>, audio = new Uint8Array([82, 73, 70, 70])) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(String(url));
    if (!String(url).startsWith("/api/")) return new Response(audio, { status: 200 });
    const next = statuses.shift();
    if (next instanceof Error) throw next;
    return next ?? json({ status: "running" });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("waitForStudioJob", () => {
  it("waits through a long run and returns the finished audio", async () => {
    const { fn, calls } = fakeFetch([
      json({ status: "queued" }),
      ...Array.from({ length: 30 }, () => json({ status: "running" })), // well past 52 s
      json({ status: "done", audio_url: "https://store.test/jobs/x.wav", duration: 9.6, gen_seconds: 41 }),
    ]);
    const out = await waitForStudioJob("x", { fetchImpl: fn, sleep: noSleep });
    expect(out.durationSec).toBe(9.6);
    expect(out.genSeconds).toBe(41);
    expect(out.audioBlob.type).toBe("audio/wav");
    expect(out.audioBlob.size).toBe(4);
    expect(calls.at(-1)).toBe("https://store.test/jobs/x.wav");
  });

  it("rides out a few dropped polls", async () => {
    const { fn } = fakeFetch([
      new Error("network"),
      new Error("network"),
      json({ status: "done", audio_url: "https://store.test/jobs/x.wav", duration: 3 }),
    ]);
    await expect(waitForStudioJob("x", { fetchImpl: fn, sleep: noSleep })).resolves.toMatchObject({ durationSec: 3 });
  });

  it("reports the job's own error as a failed chunk, not as the GPU being offline", async () => {
    const { fn } = fakeFetch([json({ status: "error", error: "the narration failed: babble" })]);
    const err = await waitForStudioJob("x", { fetchImpl: fn, sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect(err.kind).toBe("api");
    expect(err.message).toMatch(/babble/);
  });

  it("calls it lost contact only after a run of failed polls", async () => {
    const { fn } = fakeFetch(Array.from({ length: 6 }, () => new Error("network")));
    const err = await waitForStudioJob("x", { fetchImpl: fn, sleep: noSleep }).catch((e) => e);
    expect(err.kind).toBe("network");
  });

  it("gives up after its time limit", async () => {
    const { fn } = fakeFetch([]);
    const err = await waitForStudioJob("x", { fetchImpl: fn, sleep: noSleep, intervalMs: 1000, limitMs: 5000 }).catch((e) => e);
    expect(err.kind).toBe("network");
    expect(err.message).toMatch(/longer than usual/);
  });
});
