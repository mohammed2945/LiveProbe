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
  // More than one page legitimately mentions the JVM bridge — the Kubernetes
  // guide covers running it as a sidecar — so target the result by its
  // destination rather than by matching text that appears in several.
  await page
    .getByRole("dialog")
    .locator('a[href="/docs/jvm"]')
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

test("Rust and C++ each get their own sidebar entry", async ({ page }) => {
  await page.goto("/docs/rust");
  const nav = page.getByRole("navigation", { name: "Documentation", exact: true });

  if (await page.getByRole("button", { name: "Open navigation" }).isVisible()) {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }

  await expect(nav.getByRole("link", { name: "Rust", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "C++", exact: true })).toBeVisible();
});

test("each language page shows only its own toolchain", async ({ page }) => {
  await page.goto("/docs/rust");
  await expect(page.getByText("[profile.release]")).toBeVisible();
  await expect(page.getByText("-Wl,--build-id=sha1")).toHaveCount(0);

  await page.goto("/docs/cpp");
  await expect(page.getByText("-Wl,--build-id=sha1")).toBeVisible();
  await expect(page.getByText("[profile.release]")).toHaveCount(0);
});

test.describe("each language page is a standalone path", () => {
  // Splitting the languages only helps if neither page sends the reader to the
  // other one to find a step, so both must carry the whole sequence.
  const sharedSteps = [
    "1. Check the kernel",
    "3. Install the agent",
    "4. Create the unprivileged account",
    "5. Get a credential",
    "6. Write the config",
    "7. Start the loader, then the agent",
    "8. Verify",
  ];

  for (const slug of ["rust", "cpp"]) {
    test(`/docs/${slug}`, async ({ page }) => {
      await page.goto(`/docs/${slug}`);
      for (const step of sharedSteps) {
        await expect(
          page.getByRole("heading", { name: step, exact: true }),
        ).toBeVisible();
      }
      await expect(
        page.getByRole("heading", { name: "Troubleshooting", exact: true }),
      ).toBeVisible();
    });
  }
});
