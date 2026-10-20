#!/usr/bin/env bun
import { $ } from "bun";

const dir = new URL("..", import.meta.url).pathname;
process.chdir(dir);

const tag = process.argv[2] || "next";
if (!["next", "latest"].includes(tag)) throw new Error("Usage: bun script/publish.ts [next|latest]");

const pkg = await Bun.file("./package.json").json();
const version = pkg.version;
const ref = (await $`git branch --show-current`.text()).trim();
if (!ref) throw new Error("Choose a branch before publishing.");
if ((await $`git status --porcelain`.text()).trim()) throw new Error("Commit and push your changes before publishing.");

await $`npm test`;
console.log(`Publishing ${version} from ${ref} with npm tag ${tag}; no version bump, commit, or push is performed.`);
await $`gh workflow run publish.yml --ref ${ref} -f tag=${tag}`;
