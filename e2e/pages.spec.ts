import { expect, test } from "@playwright/test";
import { ADMIN_PAGES, STUDIO_PAGES, fixtures, mockApi, watchErrors } from "./helpers";

/** Every page in both sections loads, shows its heading, and logs no errors. */

for (const { path, title } of [...STUDIO_PAGES, ...ADMIN_PAGES]) {
  test(`${path} loads without console errors`, async ({ page }) => {
    const errors = watchErrors(page);
    await mockApi(page);
    const res = await page.goto(path, { waitUntil: "networkidle" });
    expect(res?.status()).toBe(200);
    if (path === "/studio") {
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    } else {
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    }
    // Section-specific chrome.
    if (path.startsWith("/admin")) {
      await expect(page.getByText("Admin", { exact: true }).first()).toBeVisible();
      await expect(page.getByTestId("section-switch")).toHaveText(/Studio/);
    } else {
      await expect(page.getByTestId("gpu-status")).toBeVisible();
    }
    await page.waitForTimeout(300);
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

test("login page loads without console errors", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/login", { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("the GPU pill says only Ready, Busy or Offline", async ({ page }) => {
  await mockApi(page);
  await page.goto("/studio/speech", { waitUntil: "networkidle" });
  const pill = page.getByTestId("gpu-status");
  await expect(pill).toHaveAttribute("data-state", "ready");
  await expect(pill).toHaveText(/GPU\s*Ready/);
  // The old technical pill showed the GPU model; the studio no longer does.
  await expect(page.locator("header").first()).not.toContainText("Tesla");
  await expect(page.locator("main")).not.toContainText("Tesla");
});

test("studio shows a plain offline notice when no GPU is running", async ({ page }) => {
  await mockApi(page, (c) =>
    c.path === "/api/gateway/status"
      ? { json: { ...fixtures.gatewayStatus, backend: null } }
      : undefined
  );
  await page.goto("/studio/speech", { waitUntil: "networkidle" });
  await expect(page.getByTestId("gpu-status")).toHaveAttribute("data-state", "offline");
  await expect(page.getByTestId("gpu-offline-notice")).toContainText("No GPU is running right now");
});
