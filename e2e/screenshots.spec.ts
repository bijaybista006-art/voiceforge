import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { ADMIN_PAGES, STUDIO_PAGES, mockApi, setTheme, watchErrors } from "./helpers";

/**
 * Screenshots of every page, light and dark, desktop and phone, into
 * docs/redesign-screenshots/. Opt-in so ordinary runs don't rewrite them:
 *
 *   SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts
 */

const OUT = "docs/redesign-screenshots";
const PAGES = [...STUDIO_PAGES, ...ADMIN_PAGES, { path: "/login", title: "Login" }];
const SIZES = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 375, height: 812 },
] as const;

const slug = (p: string) => (p === "/" ? "root" : p.slice(1).replace(/\//g, "-"));

test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to regenerate docs/redesign-screenshots");

for (const theme of ["light", "dark"] as const) {
  for (const size of SIZES) {
    test.describe(`${theme} ${size.name}`, () => {
      test.use({ viewport: { width: size.width, height: size.height }, colorScheme: theme });
      for (const { path } of PAGES) {
        test(path, async ({ page }) => {
          mkdirSync(OUT, { recursive: true });
          const errors = watchErrors(page);
          await setTheme(page, theme);
          await mockApi(page);
          await page.goto(path, { waitUntil: "networkidle" });
          await page.waitForTimeout(500);
          await page.screenshot({
            path: `${OUT}/${slug(path)}--${theme}--${size.name}.jpg`,
            fullPage: true,
            type: "jpeg",
            quality: 70,
          });
          expect(errors, errors.join("\n")).toEqual([]);
        });
      }
    });
  }
}
