#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse } from "jsonc-parser";

export async function bootstrap(configDir = process.env.OPENCODE_CONFIG_DIR ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode")) {
  let configPath = path.join(configDir, "opencode.json");
  let text;
  try { text = await readFile(configPath, "utf8"); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    configPath = path.join(configDir, "opencode.jsonc");
    try { text = await readFile(configPath, "utf8"); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      configPath = path.join(configDir, "opencode.json");
      text = "{}\n";
    }
  }
  const errors = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Invalid config: ${configPath}. Refusing to overwrite it.`);
  }
  if (config.provider?.zed && !config.providers?.zed) {
    throw new Error("Legacy provider.zed exists. Migrate that entry to V2 providers.zed first; this helper will not discard it.");
  }
  const set = (keys, value) => {
    text = applyEdits(text, modify(text, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  };
  if (!config.$schema) set(["$schema"], "https://opencode.ai/config.json");
  if (!config.providers?.zed) set(["providers", "zed"], {
    name: "Zed",
    package: "@opencode/ai/providers/openai/responses",
    settings: { baseURL: "https://cloud.zed.dev", transport: "http", encoding: "none" },
  });
  const plugins = config.plugins ?? config.plugin ?? [];
  if (!Array.isArray(plugins)) throw new Error("Expected a plugins array; refusing to overwrite it.");
  const hasPlugin = plugins.some((plugin) => {
    const name = typeof plugin === "string" ? plugin : plugin?.package;
    return name === "opencode-zed-auth" || name?.startsWith("opencode-zed-auth@");
  });
  if (!config.plugins || !hasPlugin) {
    set(["plugins"], hasPlugin ? plugins : [...plugins, "opencode-zed-auth"]);
  }
  await mkdir(configDir, { recursive: true });
  if (text !== "{}\n") {
    try { await writeFile(`${configPath}.zed-backup`, await readFile(configPath), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (!["ENOENT", "EEXIST"].includes(error.code)) throw error; }
  }
  await writeFile(configPath, text, { mode: 0o600 });
  return configPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bootstrap().then((configPath) => {
    console.log(`Configured ${configPath}. Next: /connect → Zed, then /models.`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
