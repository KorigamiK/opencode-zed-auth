import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { configuredUrls, normalizeAccessToken } from "../src/cloud.js";

const execFileAsync = promisify(execFile);

// This file runs ONLY when the user explicitly chooses desktop import.
async function readLocalCredentials() {
  const urls = configuredUrls();
  try {
    if (process.platform === "darwin") {
      const { stdout, stderr } = await execFileAsync("security", ["find-internet-password", "-s", urls.serverUrl]);
      const userId = `${stdout}\n${stderr}`.match(/"acct"<blob>="([^"]+)"/)?.[1];
      if (!userId) return null;
      const result = await execFileAsync("security", ["find-internet-password", "-s", urls.serverUrl, "-a", userId, "-w"]);
      return { userId, accessToken: normalizeAccessToken(result.stdout) };
    }
    if (process.platform === "linux") {
      const { stdout } = await execFileAsync("secret-tool", ["search", "--all", "--unlock", "url", urls.serverUrl]);
      const userId = stdout.match(/^attribute\.username = (.+)$/m)?.[1]?.trim();
      const token = stdout.match(/^secret = (.+)$/m)?.[1];
      if (userId && token) return { userId, accessToken: normalizeAccessToken(token) };
    }
  } catch { /* Report failure without credential contents. */ }
  return null;
}

// OpenCode command auth saves stdout as the key. Never log the secret elsewhere.
const credentials = await readLocalCredentials();
if (!credentials) {
  console.error("No Zed desktop credential found. Sign in to the Zed app first.");
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify(credentials));
}
