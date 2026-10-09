import { expect, test } from "@playwright/test";

test("home page shows the example questions and the map", async ({ page }) => {
  await page.goto("/");
  const empty = page.getByTestId("empty-state");
  await expect(empty).toBeVisible();
  await expect(empty.getByRole("button")).toHaveCount(6);
  for (const button of await empty.getByRole("button").all()) {
    await expect(button).toBeVisible();
  }
  await expect(page.getByTestId("map-canvas").first()).toBeAttached();
});

test("asks a question and gets a layer", async ({ page }) => {
  test.skip(!process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY, "needs model key");
  test.setTimeout(90_000);
  await page.goto("/");
  await page.getByRole("button", { name: /Lake Tahoe/ }).click();
  await expect(
    page.getByTestId("tool-trace").filter({ hasText: "query_osm-trails" }).first(),
  ).toBeVisible({ timeout: 60_000 });
});
