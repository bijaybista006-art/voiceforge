import { expect, test } from "@playwright/test";
import { AUTH_BASE, E2E_AUTH } from "./env";
import { mockApi } from "./helpers";

/** Old addresses keep working, and the two sections link to each other. */

const REDIRECTS: Array<[string, string]> = [
  ["/", "/studio"],
  ["/studio/home", "/studio"],
  ["/studio/video", "/studio/presenter"],
  ["/studio/clips", "/studio/ai-video"],
  ["/speech", "/studio/speech"],
  ["/presenter", "/studio/presenter"],
  ["/ai-video", "/studio/ai-video"],
  ["/library", "/studio/library"],
];

for (const [from, to] of REDIRECTS) {
  test(`${from} redirects to ${to}`, async ({ page }) => {
    await mockApi(page);
    await page.goto(from);
    await expect(page).toHaveURL(new RegExp(`${to.replace(/\//g, "\\/")}$`));
  });
}

test("admin URLs are unchanged", async ({ page }) => {
  await mockApi(page);
  for (const p of ["/admin", "/admin/backends", "/admin/voices", "/admin/api", "/admin/settings"]) {
    const res = await page.goto(p);
    expect(res?.status(), p).toBe(200);
    await expect(page).toHaveURL(new RegExp(`${p}$`));
  }
});

test("one switch moves between Studio and Admin", async ({ page }) => {
  await mockApi(page);
  await page.goto("/studio");
  await page.getByTestId("section-switch").click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.getByTestId("section-switch").click();
  await expect(page).toHaveURL(/\/studio$/);
});

test("studio sidebar lists only studio tools", async ({ page }) => {
  await mockApi(page);
  await page.goto("/studio");
  const nav = page.getByRole("navigation").first();
  const hrefs = await nav.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  expect(hrefs).toEqual(["/studio", "/studio/speech", "/studio/presenter", "/studio/ai-video", "/studio/library"]);
});

test.describe("with login switched on", () => {
  test("a signed-out visitor sees no studio or admin, only the login page", async ({ page }) => {
    for (const p of ["/studio", "/studio/speech", "/admin", "/admin/backends"]) {
      await page.goto(`${AUTH_BASE}${p}`);
      await expect(page).toHaveURL(/\/login/);
      await expect(page.locator('a[href^="/admin"]')).toHaveCount(0);
      await expect(page.getByTestId("section-switch")).toHaveCount(0);
    }
  });

  test("admin API stays protected", async ({ request }) => {
    const res = await request.get(`${AUTH_BASE}/api/admin/backends`);
    expect(res.status()).toBe(401);
  });

  test("signing in lands in the studio, with the switch to Admin", async ({ page }) => {
    await page.goto(`${AUTH_BASE}/login`);
    await page.locator("#password").fill(E2E_AUTH.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/studio$/);
    await expect(page.getByTestId("section-switch")).toHaveText(/Admin/);
  });
});
