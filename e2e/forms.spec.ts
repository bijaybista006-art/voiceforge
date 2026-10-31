import { expect, test } from "@playwright/test";
import { mockApi, writes } from "./helpers";

/**
 * The three studio tools send the same requests as before the redesign.
 * Request bodies are built by code the redesign did not change
 * (lib/gateway.ts, lib/clipClient.ts, the generate() in VideoView); these
 * tests pin the shape so a future UI change can't silently alter it.
 */

test("Text to Speech posts each piece to /api/gateway/generate", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/studio/speech", { waitUntil: "networkidle" });
  await page.getByRole("textbox", { name: "Narration script" }).fill("Hello there. This is a short test narration.");
  const generate = page.getByRole("button", { name: "Generate all" });
  await expect(generate).toBeEnabled();
  await generate.click();

  await expect.poll(() => writes(calls).filter((c) => c.path === "/api/gateway/generate").length).toBeGreaterThan(0);
  const req = writes(calls).find((c) => c.path === "/api/gateway/generate")!;
  expect(req.method).toBe("POST");
  const body = req.body as Record<string, unknown>;
  expect(body.text).toContain("Hello there");
  expect(body.voiceId).toBe("bijay-english-faafab11");
  expect(typeof body.model).toBe("string");
  expect(typeof body.seed).toBe("number");
  const allowed = ["text", "voiceId", "model", "seed", "language", "exaggeration", "cfg", "temperature", "stylePrompt"];
  expect(Object.keys(body).filter((k) => !allowed.includes(k))).toEqual([]);
});

test("Presenter Video posts {text, voiceId, presenterId}", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/studio/presenter", { waitUntil: "networkidle" });
  await page.getByRole("textbox", { name: "What the presenter says" }).fill("Welcome back to the channel.");
  const generate = page.getByRole("button", { name: "Generate video" });
  await expect(generate).toBeEnabled();
  await generate.click();

  await expect
    .poll(() => writes(calls).filter((c) => c.path === "/api/admin/presenter-clips").length)
    .toBe(1);
  const req = writes(calls).find((c) => c.path === "/api/admin/presenter-clips")!;
  expect(req.method).toBe("POST");
  expect(req.body).toEqual({
    text: "Welcome back to the channel.",
    voiceId: "bijay-english-faafab11",
    presenterId: "avatar-1-42f29930",
  });
  // Then it follows the job.
  await expect.poll(() => calls.some((c) => c.path === "/api/admin/presenter-clips/e2e-presenter-1")).toBe(true);
});

test("AI Video posts the same clip request (defaults)", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/studio/ai-video", { waitUntil: "networkidle" });
  await page.getByRole("textbox", { name: "Scene description" }).fill("A calm lake at dawn, mist, slow pan");
  const generate = page.getByRole("button", { name: "Generate clip" });
  await expect(generate).toBeEnabled();
  await generate.click();

  await expect.poll(() => writes(calls).filter((c) => c.path === "/api/gateway/clips").length).toBe(1);
  const req = writes(calls).find((c) => c.path === "/api/gateway/clips")!;
  expect(req.method).toBe("POST");
  expect(req.body).toEqual({
    prompt: "A calm lake at dawn, mist, slow pan",
    aspect: "landscape",
    numFrames: 121,
    steps: 50,
    guidance: 5,
  });
  await expect.poll(() => calls.some((c) => c.path === "/api/gateway/clips/e2e-clip-1")).toBe(true);
});

test("AI Video sends Shorts format, quality, seed and negative prompt when set", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/studio/ai-video", { waitUntil: "networkidle" });
  await page.getByRole("textbox", { name: "Scene description" }).fill("Rainy neon street");
  await page.getByRole("radiogroup", { name: "Format" }).getByRole("radio", { name: /9:16/ }).click();
  await page.getByLabel("Quality").selectOption("720p");
  await page.getByText(/Advanced/).first().click();
  await page.getByLabel(/Negative prompt/i).fill("blurry");
  await page.getByLabel(/^Seed/).fill("42");
  await page.getByRole("button", { name: "Generate clip" }).click();

  await expect.poll(() => writes(calls).filter((c) => c.path === "/api/gateway/clips").length).toBe(1);
  const body = writes(calls).find((c) => c.path === "/api/gateway/clips")!.body as Record<string, unknown>;
  expect(body).toMatchObject({
    prompt: "Rainy neon street",
    aspect: "vertical",
    quality: "720p",
    negativePrompt: "blurry",
    seed: 42,
  });
});

test("My Library reads the job history and offers downloads", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/studio/library", { waitUntil: "networkidle" });
  expect(calls.some((c) => c.method === "GET" && c.path === "/api/admin/jobs")).toBe(true);
  expect(writes(calls)).toEqual([]);
  await expect(page.getByRole("button", { name: /Download AI video clip/ })).toBeVisible();
  await page.getByRole("tab", { name: "Narration" }).click();
  await expect(page.getByRole("list", { name: "Your files" }).getByRole("listitem")).toHaveCount(2);
});
