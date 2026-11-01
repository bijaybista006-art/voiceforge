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

test("Presenter Video shows real lip-sync progress while it runs", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vf:presenter-clip", "e2e-presenter-9"));
  await mockApi(page, (c) =>
    c.path === "/api/admin/presenter-clips/e2e-presenter-9"
      ? {
          json: {
            jobId: "e2e-presenter-9",
            status: "running",
            stage: "lip-syncing",
            progress: 52,
            backend: "kaggle",
            videoUrl: null,
            duration: null,
            genSeconds: null,
            error: null,
            diagnostics: null,
            createdAt: Date.now() - 600_000,
          },
        }
      : undefined
  );
  await page.goto("/studio/presenter", { waitUntil: "networkidle" });
  const box = page.getByTestId("lipsync-progress");
  await expect(box).toBeVisible();
  await expect(box.getByRole("progressbar", { name: "Lip-sync progress" })).toHaveAttribute("aria-valuenow", "52");
  await expect(box).toContainText("52% · Redrawing the mouth");
  await expect(page.getByText(/10–30 minutes/).first()).toBeVisible();
});

test("AI Video never uses the paid GPU silently while a free one is installing", async ({ page }) => {
  const calls = await mockApi(page, (c) =>
    c.method === "GET" && c.path === "/api/gateway/clips"
      ? {
          json: {
            ready: true,
            provider: "modal",
            paid: true,
            skipped: [
              { provider: "colab", reason: "offline", coming: false },
              { provider: "kaggle", reason: "still installing AI video (downloading the weights)", coming: true },
            ],
            limits: { default_quality: "720p", max_frames: 121, fps: 24 },
          },
        }
      : undefined
  );
  await page.goto("/studio/ai-video", { waitUntil: "networkidle" });
  const notice = page.getByTestId("paid-notice");
  await expect(notice).toContainText("The next clip will run on Modal, which is paid.");
  await expect(notice).toContainText("Kaggle: still installing AI video");
  await expect(notice).toContainText("Google Colab: offline");

  await page.getByRole("textbox", { name: "Scene description" }).fill("A calm lake at dawn");
  await page.getByRole("button", { name: "Generate clip" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Use Modal (paid) for this clip?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(writes(calls).filter((c) => c.path === "/api/gateway/clips")).toEqual([]);

  await page.getByRole("button", { name: "Generate clip" }).click();
  await page.getByTestId("confirm-accept").click();
  await expect.poll(() => writes(calls).filter((c) => c.path === "/api/gateway/clips").length).toBe(1);
});

test("AI Video says where a clip ran and why", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("vf:ai-clip", JSON.stringify({ id: "e2e-clip-7", at: Date.now() - 60_000 }))
  );
  await mockApi(page, (c) =>
    c.path === "/api/gateway/clips/e2e-clip-7"
      ? {
          json: {
            job_id: "e2e-clip-7",
            status: "running",
            stage: "generating",
            progress: 30,
            backend: "modal",
            video_url: null,
            duration: null,
            gen_seconds: null,
            settings: null,
            error: null,
            skipped: ["Kaggle: failed (ran out of GPU memory)"],
          },
        }
      : undefined
  );
  await page.goto("/studio/ai-video", { waitUntil: "networkidle" });
  await expect(page.getByTestId("routed-note")).toContainText("Made on Modal because Kaggle: failed (ran out of GPU memory)");
});
