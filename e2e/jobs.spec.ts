import { expect, test } from "@playwright/test";
import { mockApi } from "./helpers";

/** Admin → Jobs lists narration, presenter and AI video together, filterable by type and status. */

test("Jobs shows every type together and filters by type and status", async ({ page }) => {
  await mockApi(page);
  await page.goto("/admin/jobs", { waitUntil: "networkidle" });
  const cards = page.getByTestId("job-card");
  await expect(cards).toHaveCount(4);
  await expect(page.getByRole("list", { name: "Jobs" })).toContainText("AI video clip");
  await expect(page.getByRole("list", { name: "Jobs" })).toContainText("Presenter clip");
  await expect(page.getByRole("list", { name: "Jobs" })).toContainText("Narration");

  const types = page.getByRole("tablist", { name: "Job type" });
  await types.getByRole("tab", { name: /AI video/ }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("AI video clip");

  await types.getByRole("tab", { name: /Narration/ }).click();
  await expect(cards).toHaveCount(2);
  await page.getByRole("tablist", { name: "Job status" }).getByRole("tab", { name: /Failed/ }).click();
  await expect(cards).toHaveCount(1);
  await expect(page.getByRole("tablist", { name: "Job type" }).getByRole("tab", { name: /AI video/ })).toContainText("0");

  await types.getByRole("tab", { name: /All types/ }).click();
  await page.getByRole("tablist", { name: "Job status" }).getByRole("tab", { name: /^All/ }).click();
  await expect(cards).toHaveCount(4);
});
