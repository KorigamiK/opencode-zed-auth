import { randomUUID } from "node:crypto";
export const DEFAULTS = {
  serverUrl: "https://zed.dev",
  cloudUrl: "https://cloud.zed.dev",
  llmUrl: "https://cloud.zed.dev",
  appVersion: process.env.ZED_APP_VERSION || "1.9.0",
};

export const PACKAGES = {
  anthropic: "@opencode/ai/providers/anthropic",
  open_ai: "@opencode/ai/providers/openai/responses",
  google: "@opencode/ai/providers/google",
  x_ai: "@opencode/ai/providers/xai",
};

export function configuredUrls(settings = {}) {
  const trim = (value) => String(value).replace(/\/+$/, "");
  const serverUrl = trim(settings.serverUrl || process.env.ZED_SERVER_URL || DEFAULTS.serverUrl);
  const cloudUrl = serverUrl === DEFAULTS.serverUrl || serverUrl === "https://staging.zed.dev"
    ? DEFAULTS.cloudUrl : serverUrl === "http://localhost:3000" ? "http://localhost:8787" : serverUrl;
  return {
    serverUrl,
    cloudUrl: trim(settings.cloudUrl || process.env.ZED_CLOUD_URL || cloudUrl),
    llmUrl: trim(settings.llmUrl || process.env.ZED_LLM_URL ||
      (serverUrl === "https://staging.zed.dev" ? "https://llm-staging.zed.dev" : cloudUrl)),
  };
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

export function normalizeAccessToken(value) {
  const text = (typeof value === "string" ? value : JSON.stringify(value ?? ""))
    .replace(/^secret\s*=\s*/i, "").trim();
  const secret = parseJson(text);
  return secret?.id && secret?.token
    ? JSON.stringify({ version: secret.version ?? 2, id: String(secret.id), token: String(secret.token) })
    : text;
}

export function parseCredentials(credential) {
  if (credential?.type === "key" || credential?.type === "api") {
    const parsed = parseJson(credential.key);
    if (parsed?.userId && parsed?.accessToken) {
      return { userId: String(parsed.userId).trim(), accessToken: normalizeAccessToken(parsed.accessToken) };
    }
    const [userId, ...token] = String(credential.key).trim().split(/\s+/);
    if (userId && token.length) return { userId, accessToken: normalizeAccessToken(token.join(" ")) };
  }
  if (credential?.type === "oauth") {
    const userId = credential.metadata?.accountId || credential.metadata?.userId || credential.accountId;
    if (userId && credential.refresh) return { userId: String(userId), accessToken: normalizeAccessToken(credential.refresh) };
  }
  throw new Error("Zed credentials are missing or invalid. Use /connect → Zed and paste the JSON {userId, accessToken}, or import local desktop credentials.");
}

export class ZedHttpError extends Error {
  constructor(action, response) {
    super(`${action} failed (HTTP ${response.status}).${response.status === 401
      ? " Zed rejected the desktop credential; sign in to Zed again and reconnect/import it in OpenCode."
      : " Check your Zed account, subscription, and endpoint settings."}`);
    this.status = response.status;
  }
}

export class ZedRuntime {
  constructor(settings = {}, { fetch: fetchImpl = globalThis.fetch } = {}) {
    this.settings = settings;
    this.urls = configuredUrls(settings);
    this.fetch = fetchImpl;
    this.systemId = settings.systemId || process.env.ZED_SYSTEM_ID || randomUUID();
    this.organizationId = settings.organizationId || process.env.ZED_ORGANIZATION_ID || null;
    this.models = new Map();
    this.token = null;
    this.refreshKey = null;
    this.tokenTask = null;
    this.authError = null;
  }

  async authenticatedJson(path, credentials, { method = "GET", body, signal } = {}) {
    const response = await this.fetch(new URL(path, this.urls.cloudUrl), {
      method,
      headers: {
        Authorization: `${credentials.userId} ${credentials.accessToken}`,
        "Content-Type": "application/json",
        "x-zed-system-id": this.systemId,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal || AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ZedHttpError(`Zed ${path}`, response);
    }
    return response.json();
  }

  async mintToken(credentials, signal) {
    const mint = () => this.authenticatedJson("/client/llm_tokens", credentials, {
      method: "POST", body: { organization_id: this.organizationId }, signal,
    });
    try { return (await mint()).token; } catch (error) {
      if (error.status === 401 || this.settings.organizationId || process.env.ZED_ORGANIZATION_ID) throw error;
      const user = await this.authenticatedJson("/client/users/me", credentials, { signal });
      const organizationId = user.organizations?.[0]?.id || null;
      if (organizationId === this.organizationId) throw error;
      this.organizationId = organizationId;
      return (await mint()).token;
    }
  }

  async ensureToken(credential, { force = false } = {}) {
    const saved = parseCredentials(credential);
    const refreshKey = JSON.stringify(saved);
    if (this.tokenTask && this.tokenTask.key !== refreshKey) {
      const previous = this.tokenTask;
      await previous.task.catch(() => {});
      if (this.tokenTask === previous) this.tokenTask = null;
      return this.ensureToken(credential, { force });
    }
    if (refreshKey !== this.refreshKey) {
      this.refreshKey = refreshKey;
      this.token = null;
      this.authError = null;
      this.organizationId = this.settings.organizationId || process.env.ZED_ORGANIZATION_ID || null;
    }
    if (this.authError) throw this.authError;
    if (force) this.token = null;
    if (this.token) return this.token;
    if (!this.tokenTask) {
      const task = this.mintToken(saved);
      this.tokenTask = { key: refreshKey, task };
    }
    const pending = this.tokenTask;
    try {
      const token = await pending.task;
      if (!token) throw new Error("Zed returned no LLM token.");
      if (this.refreshKey === pending.key) this.token = token;
      else return this.ensureToken(credential);
      return token;
    } catch (error) {
      if (error.status === 401 && this.refreshKey === pending.key) this.authError = error;
      throw error;
    } finally {
      if (this.tokenTask === pending) this.tokenTask = null;
    }
  }

  async discover(credential) {
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.ensureToken(credential, { force: attempt > 0 });
      response = await this.fetch(new URL("/models", this.urls.llmUrl), {
        headers: { Authorization: `Bearer ${token}`, "x-zed-client-supports-x-ai": "true" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!shouldRefreshToken(response) || attempt) break;
      await response.body?.cancel();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ZedHttpError("Listing Zed models", response);
    }
    const { models } = await response.json();
    const supported = (models || []).filter((model) => PACKAGES[model.provider]);
    if (!supported.length) throw new Error("Zed returned an empty supported model catalog; keeping the previous catalog.");
    this.models = new Map(supported.map((model) => [model.id, model]));
    return supported;
  }

  async wrapRequest(request, model, credential, { sessionID } = {}, force = false) {
    const body = await request.clone().json();
    const token = await this.ensureToken(credential, { force });
    const threadId = sessionID || request.headers.get("x-opencode-zed-thread-id") || randomUUID();
    body.model = model.provider === "google" ? `models/${model.id}` : model.id;
    const providerRequest = model.provider === "open_ai" ? normalizeOpenAiRequest(body, threadId, model) : body;
    return new Request(new URL("/completions", this.urls.llmUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-zed-version": this.settings.appVersion || DEFAULTS.appVersion,
        "x-zed-client-supports-status-messages": "true",
        "x-zed-client-supports-stream-ended-request-completion-status": "true",
      },
      body: JSON.stringify({
        thread_id: threadId,
        prompt_id: randomUUID(),
        intent: "user_prompt",
        provider: model.provider,
        model: model.id,
        provider_request: providerRequest,
      }),
      signal: request.signal,
    });
  }
}

export function shouldRefreshToken(response) {
  return response.status === 401 || response.headers.has("x-zed-expired-token") || response.headers.has("x-zed-outdated-token");
}

export function normalizeOpenAiRequest(body, threadId, model) {
  const result = { ...body, model: model.id, stream: true, prompt_cache_key: body.prompt_cache_key || threadId };
  // Zed's Responses envelope accepts messages, function calls and reasoning, but
  // not OpenCode's transport-only state or OpenAI's persistent response IDs.
  delete result.store;
  delete result.previous_response_id;
  delete result.include;
  delete result.stream_options;
  if (!model.supports_thinking) delete result.reasoning;
  result.input = (typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input || [])
    .map((item) => {
      if (item.type === "function_call" || item.type === "function_call_output") {
        const { id, status, ...call } = item;
        return call;
      }
      if (item.type === "reasoning") return item;
      const role = item.role === "developer" ? "system" : item.role;
      if (!["system", "user", "assistant"].includes(role)) return null;
      const content = typeof item.content === "string"
        ? [{ type: role === "assistant" ? "output_text" : "input_text", text: item.content }]
        : item.content;
      return { type: "message", role, content: (content || []).map((part) =>
        part.type === "output_text" ? { ...part, annotations: part.annotations || [] } : part) };
    }).filter(Boolean);
  return result;
}

export function streamAsSse(response, provider) {
  if (!response.body || !response.ok) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let ended = false;
  function event(line) {
    const text = line.trim();
    if (!text) return null;
    const parsed = parseJson(text);
    if (!parsed) throw new Error("Zed returned an invalid JSON stream event.");
    if (parsed.status && !parsed.event) {
      const status = typeof parsed.status === "string" ? parsed.status : parsed.status.type || parsed.status.status;
      if (["error", "failed"].includes(status) || parsed.error || parsed.status.error) throw new Error("Zed reported a completion stream failure.");
      return null;
    }
    const data = parsed.event || parsed;
    return `${provider === "anthropic" && data.type ? `event: ${data.type}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
  }
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const index = buffer.indexOf("\n");
          if (index >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            const frame = event(line);
            if (frame) { controller.enqueue(encoder.encode(frame)); return; }
            continue;
          }
          if (ended) {
            const frame = event(buffer);
            buffer = "";
            if (frame) controller.enqueue(encoder.encode(frame));
            controller.close();
            reader.releaseLock();
            return;
          }
          const { done, value } = await reader.read();
          ended = done;
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        }
      } catch (error) {
        controller.error(error);
        await reader.cancel(error).catch(() => {});
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  return new Response(stream, { status: response.status, statusText: response.statusText, headers });
}
