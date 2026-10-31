import { expect, test } from "@playwright/test";
import { mockApi } from "./helpers";

/** Light / Dark / System, remembered, applied before first paint. */

const html = (page: import("@playwright/test").Page) => page.locator("html");

test("defaults to System and follows the OS", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await mockApi(page);
  await page.goto("/studio");
  await expect(html(page)).toHaveAttribute("data-theme-pref", "system");
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html(page)).toHaveAttribute("data-theme", "light");
});

test("choosing Dark persists across reloads and sections", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await mockApi(page);
  await page.goto("/studio");
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Dark" }).click();
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => localStorage.getItem("vf-theme"))).toBe("dark");

  await page.reload();
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  await page.goto("/admin/backends");
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");

  // Background really changes (tokens, not just an attribute).
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(9, 12, 20)");
});

test("choosing Light overrides a dark OS", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await mockApi(page);
  await page.goto("/admin");
  await page.getByRole("radio", { name: "Light" }).click();
  await expect(html(page)).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(html(page)).toHaveAttribute("data-theme", "light");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(244, 246, 250)");
});

test("no flash: the saved theme is on <html> in the server HTML's first script", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vf-theme", "dark"));
  await mockApi(page);
  // Read the attribute as soon as the DOM exists, before React hydrates.
  let early: string | null = null;
  page.on("domcontentloaded", async () => {
    early = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  });
  await page.goto("/studio/speech", { waitUntil: "domcontentloaded" });
  await expect.poll(() => early).toBe("dark");
});

test("theme toggle is keyboard operable", async ({ page }) => {
  await mockApi(page);
  await page.goto("/studio");
  const light = page.getByRole("radio", { name: "Light" });
  await light.click();
  await light.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
});
