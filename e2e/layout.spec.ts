import { expect, test } from "@playwright/test";
import { ADMIN_PAGES, STUDIO_PAGES, mockApi } from "./helpers";

/** 375 px (phone) and 1440 px (desktop): no sideways scroll; sidebar vs menu. */

const ALL = [...STUDIO_PAGES, ...ADMIN_PAGES];

test.describe("375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  for (const { path } of ALL) {
    test(`${path} fits without horizontal scroll`, async ({ page }) => {
      await mockApi(page);
      await page.goto(path, { waitUntil: "networkidle" });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test("sidebar becomes a menu", async ({ page }) => {
    await mockApi(page);
    await page.goto("/studio");
    const open = page.getByRole("button", { name: "Open menu" });
    await expect(open).toBeVisible();
    await open.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("link", { name: "AI Video" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await open.click();
    await page.getByRole("dialog").getByRole("link", { name: "My Library" }).click();
    await expect(page).toHaveURL(/\/studio\/library$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("admin menu has every admin page", async ({ page }) => {
    await mockApi(page);
    await page.goto("/admin");
    await page.getByRole("button", { name: "Open menu" }).click();
    const dialog = page.getByRole("dialog");
    for (const { title } of ADMIN_PAGES) {
      await expect(dialog.getByRole("link", { name: title, exact: true })).toBeVisible();
    }
  });
});

test.describe("1440px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const { path } of ALL) {
    test(`${path} fits, with the sidebar visible`, async ({ page }) => {
      await mockApi(page);
      await page.goto(path, { waitUntil: "networkidle" });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
      await expect(page.locator("aside nav").first()).toBeVisible();
    });
  }
});
