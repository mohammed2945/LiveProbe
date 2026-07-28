import { readdir, readFile, writeFile } from "node:fs/promises";

const SITE_ORIGIN = "https://docs.liveprobe.tryastrea.tech";
const CLIENT_DIR = "dist/client";

// `vinext build` rewrites next-env.d.ts to reference ./.next/types/routes.d.ts,
// but .next/ is a build directory and is gitignored. Committing that reference
// would break `tsc --noEmit` on a fresh clone, where the file it points at does
// not exist yet. Stripping it after every build keeps the committed file
// portable.
const nextEnvPath = "next-env.d.ts";
const nextEnv = await readFile(nextEnvPath, "utf8");
await writeFile(
  nextEnvPath,
  nextEnv.replace('import "./.next/types/routes.d.ts";\n', ""),
);

// app/sitemap.ts would be the natural home for this, but Next metadata routes
// are not emitted under `output: "export"`, so the deployed site would silently
// lose its sitemap. Deriving it from the pages the build actually produced is
// also stricter than a hand-maintained list: a slug can never appear here
// without a corresponding HTML file existing next to it.
const slugs = (await readdir(`${CLIENT_DIR}/docs`))
  .filter((entry) => entry.endsWith(".html"))
  .map((entry) => entry.slice(0, -".html".length))
  .sort();

if (slugs.length === 0) {
  throw new Error("no documentation pages were emitted; refusing to write an empty sitemap");
}

const urls = slugs
  .map((slug) => {
    const priority = slug === "quickstart" ? "1.0" : "0.7";
    return [
      "  <url>",
      `    <loc>${SITE_ORIGIN}/docs/${slug}</loc>`,
      "    <changefreq>weekly</changefreq>",
      `    <priority>${priority}</priority>`,
      "  </url>",
    ].join("\n");
  })
  .join("\n");

await writeFile(
  `${CLIENT_DIR}/sitemap.xml`,
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`,
);

process.stdout.write(`sitemap.xml written with ${slugs.length} pages\n`);
