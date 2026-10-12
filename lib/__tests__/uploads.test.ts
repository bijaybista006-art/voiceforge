import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  SCENE_RETENTION_DAYS,
  expiryFor,
  maxBytesFor,
  sanitiseFilename,
  uploadPathname,
} from "../server/uploads";

/**
 * Uploads put a client-supplied name into a storage path that ffmpeg, urllib
 * and a browser all have to agree on, and decide what gets swept a week
 * later. Both are easy to get subtly wrong and hard to notice.
 */

describe("sanitiseFilename", () => {
  it("keeps an ordinary name", () => {
    expect(sanitiseFilename("scene-01.png")).toBe("scene-01.png");
  });

  it("lowercases and replaces spaces", () => {
    expect(sanitiseFilename("My Scene 1.PNG")).toBe("my-scene-1.png");
  });

  it("strips path separators, so a name can't escape its prefix", () => {
    expect(sanitiseFilename("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitiseFilename("a/b/c.png")).toBe("a-b-c.png");
  });

  it("strips characters that would need escaping in a URL", () => {
    expect(sanitiseFilename("a b&c?d#e.png")).toBe("a-b-c-d-e.png");
  });

  it("never returns empty", () => {
    expect(sanitiseFilename("???")).toBe("file");
    expect(sanitiseFilename("")).toBe("file");
  });

  it("caps the length", () => {
    expect(sanitiseFilename("x".repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it("does not leave a leading dot, which would hide the object", () => {
    expect(sanitiseFilename(".hidden.png").startsWith(".")).toBe(false);
  });
});

describe("maxBytesFor", () => {
  it("allows video to be larger than images", () => {
    expect(maxBytesFor("video/mp4")).toBe(MAX_VIDEO_BYTES);
    expect(maxBytesFor("image/png")).toBe(MAX_IMAGE_BYTES);
    expect(MAX_VIDEO_BYTES).toBeGreaterThan(MAX_IMAGE_BYTES);
  });

  it("treats every image type the same", () => {
    expect(maxBytesFor("image/jpeg")).toBe(maxBytesFor("image/webp"));
  });
});

describe("uploadPathname", () => {
  const day = new Date("2026-10-05T11:00:00Z");

  it("partitions by key and date", () => {
    expect(uploadPathname("key-1", "a.png", "uuid-1", day)).toBe(
      "uploads/key-1/2026-10-05/uuid-1-a.png"
    );
  });

  it("always sits under uploads/", () => {
    // The cleanup sweep and any storage rule key off this prefix.
    expect(uploadPathname("k", "../x.png", "id", day).startsWith("uploads/")).toBe(true);
  });

  it("keeps two uploads of the same name apart", () => {
    const a = uploadPathname("k", "same.png", "id-a", day);
    const b = uploadPathname("k", "same.png", "id-b", day);
    expect(a).not.toBe(b);
  });
});

describe("expiryFor", () => {
  const now = Date.UTC(2026, 9, 5);

  it("expires a scene upload after the retention window", () => {
    const expected = now + SCENE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    expect(expiryFor("scene", now)).toBe(expected);
  });

  it("never expires a brand asset", () => {
    // A logo deleted a week after upload would silently vanish from every
    // later render.
    expect(expiryFor("brand", now)).toBeNull();
  });
});

/**
 * A signed upload URL lets a repeat PUT replace the file at its path, so a
 * client that retries a timeout can finish. That is only safe because no two
 * uploads can ever be given the same path.
 */
describe("a retried PUT can only replace the caller's own upload", () => {
  it("gives every create a pathname of its own", () => {
    // A collision should be impossible in the first place; overwrite is for
    // a retry of the same upload, not for two uploads racing.
    const a = uploadPathname("key", "a.png", crypto.randomUUID());
    const b = uploadPathname("key", "a.png", crypto.randomUUID());
    expect(a).not.toBe(b);
  });
});
