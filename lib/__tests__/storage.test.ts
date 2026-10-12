import { beforeAll, describe, expect, it } from "vitest";
import { getAudioUrl, isOurFileUrl, kindOfPath, pathFromUrl, publicBaseUrl } from "../storage";

const BASE = "https://proj.supabase.co/storage/v1/object/public/voiceforge-audio";

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co/";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
});

describe("public URLs", () => {
  it("are built from the project address and the bucket", () => {
    expect(publicBaseUrl()).toBe(BASE);
    expect(getAudioUrl("voices/me.wav")).toBe(`${BASE}/voices/me.wav`);
    expect(getAudioUrl("/jobs/a.mp3")).toBe(`${BASE}/jobs/a.mp3`);
  });
});

/**
 * Deleting a file starts from the link stored on a record. Reading the wrong
 * path out of a link would delete the wrong file — or, for a link that is
 * not ours at all, someone else's path in our bucket.
 */
describe("pathFromUrl", () => {
  it("reads the path out of one of our links", () => {
    expect(pathFromUrl(`${BASE}/jobs/8f1c-2.mp3`)).toBe("jobs/8f1c-2.mp3");
    expect(pathFromUrl(`${BASE}/voices/me.wav?download=1`)).toBe("voices/me.wav");
  });

  it("takes a bare path as it is", () => {
    expect(pathFromUrl("uploads/k/2026-10-05/id-a.png")).toBe("uploads/k/2026-10-05/id-a.png");
  });

  it("still resolves a link written before the move, since paths were kept", () => {
    expect(pathFromUrl("https://abc.public.blob.vercel-storage.com/voices/me.wav")).toBe(
      "voices/me.wav"
    );
  });

  it("refuses a link to anywhere else", () => {
    expect(pathFromUrl("https://xyz.modal.run/render/abc/video")).toBeNull();
    expect(pathFromUrl("https://proj.supabase.co.evil.net/voices/me.wav")).toBeNull();
    expect(pathFromUrl("https://other.supabase.co/storage/v1/object/public/voiceforge-audio/a.wav")).toBeNull();
  });
});

describe("isOurFileUrl", () => {
  it("accepts only https links into our own bucket", () => {
    expect(isOurFileUrl(`${BASE}/assets/music/a.mp3`)).toBe(true);
    expect(isOurFileUrl(`${BASE.replace("https", "http")}/assets/music/a.mp3`)).toBe(false);
    expect(isOurFileUrl("https://proj.supabase.co/storage/v1/object/public/other/a.mp3")).toBe(false);
  });
});

describe("kindOfPath", () => {
  it("names a file by the folder it sits in", () => {
    expect(kindOfPath("voices/a.wav")).toBe("voice");
    expect(kindOfPath("jobs/a.mp3")).toBe("job");
    expect(kindOfPath("presenter-clips/a.mp4")).toBe("presenter-clip");
    expect(kindOfPath("presenters/image/a.png")).toBe("presenter");
    expect(kindOfPath("assets/music/a.mp3")).toBe("asset");
    expect(kindOfPath("uploads/k/d/a.png")).toBe("upload");
    expect(kindOfPath("elsewhere/a.bin")).toBe("other");
  });
});
