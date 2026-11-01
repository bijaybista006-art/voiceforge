import { expect, test, type Page } from "@playwright/test";
import { type ApiCall, mockApi, writes } from "./helpers";

/**
 * Every Backends button, switch and form, and the exact request each one
 * sends. The expected bodies are the ones the pre-redesign page sent
 * (components/admin/BackendsManager.tsx on the pre-redesign-backup tag).
 */

async function open(page: Page): Promise<ApiCall[]> {
  const calls = await mockApi(page);
  await page.goto("/admin/backends", { waitUntil: "networkidle" });
  await expect(page.getByTestId("backend-colab")).toBeVisible();
  return calls;
}

async function lastWrite(calls: ApiCall[]): Promise<ApiCall> {
  await expect.poll(() => writes(calls).length).toBeGreaterThan(0);
  return writes(calls).at(-1)!;
}

test("shows what's serving, with health and GPU", async ({ page }) => {
  await open(page);
  const serving = page.getByTestId("serving-now");
  await expect(serving).toContainText("Google Colab");
  await expect(serving).toContainText("Tesla T4");
  await expect(page.getByTestId("backend-colab").locator('[data-status="online"]')).toBeVisible();
  await expect(page.getByTestId("backend-modal").locator('[data-status="unverified"]')).toBeVisible();
  await expect(page.getByTestId("backend-colab")).toContainText("91 GPU-min");
});

test("routing explainer states the real order and what Auto means", async ({ page }) => {
  await open(page);
  const order = page.getByRole("list", { name: "Routing order" });
  await expect(order).toContainText(/Colab.*Kaggle.*Custom.*Modal/s);
  await expect(page.getByText(/Auto/).first()).toBeVisible();
});

test("Enabled switch sends {provider, enabled}", async ({ page }) => {
  const calls = await open(page);
  const sw = page.getByTestId("backend-colab").getByRole("switch", { name: "Enabled", exact: true });
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await sw.click();
  const w = await lastWrite(calls);
  expect(w).toMatchObject({ method: "PATCH", path: "/api/admin/backends" });
  expect(w.body).toEqual({ provider: "colab", enabled: false });
});

for (const [label, field, provider, expected] of [
  ["Voice", "voiceEnabled", "colab", false],
  ["Presenter", "videoEnabled", "colab", false],
  ["AI video", "clipsEnabled", "colab", false],
  ["AI video", "clipsEnabled", "modal", true],
] as const) {
  test(`${provider} ${label} switch sends {provider, ${field}: ${expected}}`, async ({ page }) => {
    const calls = await open(page);
    await page.getByTestId(`backend-${provider}`).getByRole("switch", { name: label, exact: true }).click();
    const w = await lastWrite(calls);
    expect(w).toMatchObject({ method: "PATCH", path: "/api/admin/backends" });
    expect(w.body).toEqual({ provider, [field]: expected });
  });
}

test("Test connection posts {provider} and shows the result", async ({ page }) => {
  const calls = await open(page);
  await page.getByTestId("backend-modal").getByRole("button", { name: "Test connection" }).click();
  const w = await lastWrite(calls);
  expect(w).toMatchObject({ method: "POST", path: "/api/admin/backends/test", body: { provider: "modal" } });
  await expect(page.getByTestId("backend-modal")).toContainText("Responded in 123 ms");
});

test("Remove asks first; Cancel sends nothing, confirm sends DELETE", async ({ page }) => {
  const calls = await open(page);
  await page.getByRole("button", { name: "Remove Modal" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Remove Modal?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes(calls)).toEqual([]);

  await page.getByRole("button", { name: "Remove Modal" }).click();
  await page.getByTestId("confirm-accept").click();
  const w = await lastWrite(calls);
  expect(w).toMatchObject({ method: "DELETE", path: "/api/admin/backends", search: "?provider=modal" });
});

test("Details expand and collapse", async ({ page }) => {
  await open(page);
  const card = page.getByTestId("backend-modal");
  const toggle = card.getByRole("button", { name: /Details/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(card).toContainText("voiceforge-presenter.modal.run");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("unconnected backends get setup cards; adding Custom sends {provider, url}", async ({ page }) => {
  const calls = await open(page);
  await expect(page.getByTestId("setup-kaggle")).toBeVisible();
  const custom = page.getByTestId("setup-custom");
  await expect(custom).toBeVisible();
  const add = custom.getByRole("button", { name: "Add Custom" });
  await expect(add).toBeDisabled();
  await custom.locator("#add-url-custom").fill("https://gpu.example.com");
  await add.click();
  const w = await lastWrite(calls);
  expect(w).toMatchObject({ method: "PATCH", path: "/api/admin/backends" });
  expect(w.body).toEqual({ provider: "custom", url: "https://gpu.example.com" });
});

test("setup steps have copy buttons", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  const kaggle = page.getByTestId("setup-kaggle");
  const copy = kaggle.getByRole("button", { name: /Copy/ }).first();
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(kaggle.getByText(/Copied/).first()).toBeVisible();
});

test("saved preferences: pin and priority send the same requests as before", async ({ page }) => {
  const calls = await open(page);
  await page.getByRole("button", { name: /Saved preferences/ }).click();

  await page.getByRole("radiogroup", { name: "Pinned backend" }).getByRole("radio", { name: "Modal" }).click();
  let w = await lastWrite(calls);
  expect(w).toMatchObject({ method: "PATCH", path: "/api/admin/backends", body: { active: "modal" } });

  const before = writes(calls).length;
  await page.getByRole("button", { name: "Move Modal up" }).click();
  await expect.poll(() => writes(calls).length).toBe(before + 2);
  const [a, b] = writes(calls).slice(before);
  expect(a.body).toEqual({ provider: "modal", priority: 0 });
  expect(b.body).toEqual({ provider: "colab", priority: 1 });
  w = b;
  expect(w.method).toBe("PATCH");
});

test("Open notebook links to the saved notebook", async ({ page }) => {
  await open(page);
  const link = page.getByTestId("backend-colab").getByRole("link", { name: "Open notebook" });
  await expect(link).toHaveAttribute("href", /colab\.research\.google\.com\/drive\/1AbC/);
  await expect(link).toHaveAttribute("target", "_blank");
});

test("a notebook card shows its free disk and GPU memory", async ({ page }) => {
  await open(page);
  const card = page.getByTestId("backend-colab");
  await expect(card.getByTestId("disk-free")).toContainText("46 GB free of 113");
  await expect(card.getByTestId("gpu-memory")).toContainText("3.1 / 15 GB");
});
