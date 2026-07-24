import {
  access,
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";

await mkdir("dist/.openai", { recursive: true });
await copyFile(".openai/hosting.json", "dist/.openai/hosting.json");

try {
  await access("dist/server/index.js");
} catch {
  await access("dist/server/index.mjs");
  await writeFile(
    "dist/server/index.js",
    'export { default } from "./index.mjs";\nexport * from "./index.mjs";\n',
  );
}

const nextEnvPath = "next-env.d.ts";
const nextEnv = await readFile(nextEnvPath, "utf8");
await writeFile(
  nextEnvPath,
  nextEnv.replace('import "./.next/types/routes.d.ts";\n', ""),
);
