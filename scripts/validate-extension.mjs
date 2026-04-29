import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const requiredFiles = [
  "manifest.json",
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...manifest.content_scripts.flatMap((script) => [
    ...(script.js || []),
    ...(script.css || [])
  ])
];

for (const file of requiredFiles) {
  const absolute = join(root, file);
  if (!existsSync(absolute)) {
    throw new Error(`Missing required file: ${file}`);
  }
}

for (const file of [
  "src/background/service-worker.js",
  "src/content/content-script.js",
  "src/popup/popup.js",
  "scripts/package-extension.mjs"
]) {
  execFileSync(process.execPath, ["--check", join(root, file)], {
    stdio: "inherit"
  });
}

console.log("Extension validation passed.");
