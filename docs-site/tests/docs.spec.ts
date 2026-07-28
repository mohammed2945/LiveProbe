import { expect, test } from "@playwright/test";

test("renders the quickstart and navigates between pages", async ({ page }) => {
  await page.goto("/docs/quickstart");
  await expect(
    page.getByRole("heading", { level: 1, name: "Quickstart" }),
  ).toBeVisible();

  if (await page.getByRole("button", { name: "Open navigation" }).isVisible()) {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  await page.getByRole("link", { name: "Python SDK", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/python\/?$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Python SDK" }),
  ).toBeVisible();
});

test("search routes to matching documentation", async ({ page }) => {
  await page.goto("/docs/quickstart");
  await page.getByRole("button", { name: /search documentation/i }).click();
  await page.getByRole("textbox", { name: "Search documentation" }).fill("JVM");
  await page
    .getByRole("dialog")
    .getByRole("link", { name: /JVM bridge/ })
    .click();
  await expect(page).toHaveURL(/\/docs\/jvm\/?$/);
});

test("mobile navigation opens without covering its controls", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/docs/tools");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("navigation", { name: "Documentation", exact: true }),
  ).toBeVisible();
  await expect(page.getByTitle("Close navigation")).toBeVisible();
});

test("native setup tabs switch between Rust and C++", async ({ page }) => {
  await page.goto("/docs/native");

  const rustTab = page.getByRole("tab", { name: "Rust" });
  const cppTab = page.getByRole("tab", { name: "C++" });

  // Rust is the default, so a reader who never touches the control still sees
  // a complete set of instructions rather than an empty panel.
  await expect(rustTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("[profile.release]")).toBeVisible();
  await expect(page.getByText("-Wl,--build-id=sha1")).toBeHidden();

  await cppTab.click();
  await expect(cppTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("-Wl,--build-id=sha1")).toBeVisible();
  await expect(page.getByText("[profile.release]")).toBeHidden();
});
