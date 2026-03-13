#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import plugin from "../index.mjs";

const configPath = path.join(homedir(), ".opencode", "opencode.json");

async function main() {
  let config = {};

  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {}

  const hooks = await plugin({
    client: {},
    project: {},
    directory: process.cwd(),
    worktree: process.cwd(),
    serverUrl: new URL("http://localhost"),
    $: null,
  });

  if (typeof hooks.config !== "function") {
    throw new Error("The Zed plugin does not export a config hook.");
  }

  await hooks.config(config);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  console.log(`Wrote ${configPath}`);
  console.log(`Providers: ${Object.keys(config.provider || {}).join(", ") || "(none)"}`);
  console.log(`Zed models: ${Object.keys(config.provider?.zed?.models || {}).length}`);
  console.log("Next step: run `opencode models zed` once with working auth to fetch and persist the full Zed catalog.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
