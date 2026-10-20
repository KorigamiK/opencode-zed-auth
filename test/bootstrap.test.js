import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { bootstrap } from "../script/bootstrap-config.mjs";

async function fixture(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "zed-bootstrap-test-"));
  try { await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("bootstrap creates a native V2 config without any credentials", () => fixture(async (directory) => {
  const file = await bootstrap(directory);
  const config = parse(await readFile(file, "utf8"));
  assert.deepEqual(config.plugins, ["opencode-zed-auth"]);
  assert.equal(config.providers.zed.settings.baseURL, "https://cloud.zed.dev");
  assert.equal(config.provider, undefined);
  assert.equal(config.providers.zed.settings.apiKey, undefined);
}));

test("bootstrap preserves JSONC comments, MCP servers, plugins, model overrides and a backup", () => fixture(async (directory) => {
  const file = path.join(directory, "opencode.jsonc");
  const original = '{\n // Keep this comment\n "plugins": ["existing-plugin"],\n "mcp": {"servers": {}},\n "providers": {"zed": {"models": {"custom": {"name": "My model"}}}},\n}\n';
  await writeFile(file, original);
  assert.equal(await bootstrap(directory), file);
  const text = await readFile(file, "utf8");
  const config = parse(text);
  assert.ok(text.includes("// Keep this comment"));
  assert.deepEqual(config.plugins, ["existing-plugin", "opencode-zed-auth"]);
  assert.equal(config.providers.zed.models.custom.name, "My model");
  assert.deepEqual(config.mcp, { servers: {} });
  assert.equal(await readFile(`${file}.zed-backup`, "utf8"), original);
  await bootstrap(directory);
  assert.equal(await readFile(file, "utf8"), text);
}));

test("bootstrap refuses malformed config and legacy provider conflicts", () => fixture(async (directory) => {
  const file = path.join(directory, "opencode.json");
  for (const original of ['{ broken', '{"provider":{"zed":{"name":"Old Zed"}}}']) {
    await writeFile(file, original);
    await assert.rejects(bootstrap(directory));
    assert.equal(await readFile(file, "utf8"), original);
  }
}));
