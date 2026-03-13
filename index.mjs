import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const DEFAULTS = {
  serverUrl: "https://zed.dev",
  cloudUrl: "https://cloud.zed.dev",
  llmUrl: "https://cloud.zed.dev",
  providerNpm: "@ai-sdk/openai",
  zedVersion: process.env.ZED_APP_VERSION || "0.227.1+stable",
  apiKey: "zed-cloud",
};

const HEADERS = {
  expiredToken: "x-zed-expired-token",
  outdatedToken: "x-zed-outdated-token",
  supportsXai: "x-zed-client-supports-x-ai",
  systemId: "x-zed-system-id",
  version: "x-zed-version",
  supportsStatusMessages: "x-zed-client-supports-status-messages",
  supportsStreamEndedStatus:
    "x-zed-client-supports-stream-ended-request-completion-status",
  threadId: "x-opencode-zed-thread-id",
  promptId: "x-opencode-zed-prompt-id",
  intent: "x-opencode-zed-intent",
};

const PROVIDERS = {
  anthropic: ["@ai-sdk/anthropic", "https://api.anthropic.com/v1"],
  open_ai: ["@ai-sdk/openai", "https://api.openai.com/v1"],
  google: ["@ai-sdk/google", "https://generativelanguage.googleapis.com"],
  x_ai: ["@ai-sdk/xai", "https://api.x.ai/v1"],
};

const URL_OVERRIDES = {
  "https://zed.dev": [DEFAULTS.cloudUrl, DEFAULTS.cloudUrl],
  "https://staging.zed.dev": [DEFAULTS.cloudUrl, "https://llm-staging.zed.dev"],
  "http://localhost:3000": ["http://localhost:8787", "http://localhost:8787"],
};

const OPENAI_ROLES = new Set(["system", "user", "assistant"]);
const OPENAI_TOOL_CHOICES = new Set(["auto", "none", "required"]);
const MODALITIES = ["text", "audio", "image", "video", "pdf"];
const execFileAsync = promisify(execFile);

const debugLog = (...args) => {
  if (process.env.OPENCODE_ZED_DEBUG) {
    console.error("[opencode-zed-auth]", ...args);
  }
};

const stripTrailingSlash = (value) => String(value).replace(/\/+$/, "");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const compact = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
const merge = (base, value) => (isObject(value) ? { ...base, ...value } : { ...base });
const stringify = (value, fallback = {}) => (typeof value === "string" ? value : JSON.stringify(value ?? fallback));
const parseJson = (value, fallback = null) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

function getConfiguredUrls(options = {}) {
  const serverUrl = stripTrailingSlash(
    options.serverUrl || process.env.ZED_SERVER_URL || DEFAULTS.serverUrl,
  );
  const [defaultCloudUrl, defaultLlmUrl] = URL_OVERRIDES[serverUrl] || [serverUrl, serverUrl];

  return {
    serverUrl,
    cloudUrl: stripTrailingSlash(options.cloudUrl || process.env.ZED_CLOUD_URL || defaultCloudUrl),
    llmUrl: stripTrailingSlash(options.llmUrl || process.env.ZED_LLM_URL || defaultLlmUrl),
  };
}

function normalizeAccessToken(value) {
  if (value == null) {
    return "";
  }

  const token = stringify(value).replace(/^secret\s*=\s*/i, "").trim();
  const parsed = token.startsWith("{") ? parseJson(token) : null;

  return parsed?.id && parsed?.token
    ? JSON.stringify({
        version: parsed.version ?? 2,
        id: String(parsed.id),
        token: String(parsed.token),
      })
    : token;
}

function isClientTokenSecret(value) {
  const parsed = typeof value === "string" && value.trim().startsWith("{") ? parseJson(value) : null;
  return Boolean(parsed?.id && parsed?.token);
}

function parseStoredZedCredentials(auth) {
  if (!auth) {
    throw new Error(
      "Zed credentials are missing. Sign in through the Zed desktop app first, then paste your user id and the full credential secret JSON into this provider.",
    );
  }

  if (auth.type === "oauth") {
    if (!auth.accountId) {
      throw new Error("Stored Zed OAuth credentials are missing the user id.");
    }

    return { userId: auth.accountId, accessToken: normalizeAccessToken(auth.refresh) };
  }

  if (auth.type === "api") {
    const parsed = parseJson(auth.key);
    if (parsed?.userId && parsed?.accessToken) {
      return {
        userId: String(parsed.userId).trim(),
        accessToken: normalizeAccessToken(parsed.accessToken),
      };
    }

    const [userId, ...tokenParts] = String(auth.key).trim().split(/\s+/);
    const accessToken = tokenParts.join(" ").trim();
    if (userId && accessToken) {
      return { userId, accessToken: normalizeAccessToken(accessToken) };
    }
  }

  throw new Error(
    "Stored Zed credentials are invalid. Paste your Zed user id and the full credential secret JSON again.",
  );
}

function parseSecretToolSearchOutput(output, preferredUserId = null) {
  const text = String(output);
  const userIds = Array.from(text.matchAll(/^attribute\.username = (.+)$/gm), (match) => match[1].trim()).filter(Boolean);
  const accessTokens = Array.from(text.matchAll(/^secret = (.+)$/gm), (match) => normalizeAccessToken(match[1])).filter(Boolean);
  const index = preferredUserId ? userIds.findIndex((userId) => userId === preferredUserId) : 0;
  const resolvedIndex = index >= 0 && accessTokens[index] ? index : 0;

  return userIds[resolvedIndex] && accessTokens[resolvedIndex]
    ? { userId: userIds[resolvedIndex], accessToken: accessTokens[resolvedIndex] }
    : null;
}

async function readLocalZedCredentials(urls, preferredUserId = null) {
  if (process.platform !== "linux") {
    return null;
  }

  try {
    const { stdout, stderr } = await execFileAsync("secret-tool", [
      "search",
      "--all",
      "--unlock",
      "url",
      urls.serverUrl,
    ]);
    return parseSecretToolSearchOutput(`${stdout}\n${stderr}`, preferredUserId);
  } catch {
    return null;
  }
}

async function resolveZedCredentials(auth, urls) {
  let parsedCredentials;
  let parseError;

  try {
    parsedCredentials = parseStoredZedCredentials(auth);
  } catch (error) {
    parseError = error;
  }

  if (!parsedCredentials || !isClientTokenSecret(parsedCredentials.accessToken)) {
    const localCredentials = await readLocalZedCredentials(urls, parsedCredentials?.userId);
    if (localCredentials) {
      return localCredentials;
    }
  }

  if (parsedCredentials) {
    return parsedCredentials;
  }

  throw parseError;
}

const buildCloudAuthorization = (credentials) => `${credentials.userId} ${credentials.accessToken}`;
const buildUrl = (baseUrl, pathname) => new URL(pathname, `${baseUrl}/`).toString();

async function fetchJson(url, init = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(url, { ...init, headers });
}

function fetchAuthenticatedJson(url, credentials, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", buildCloudAuthorization(credentials));
  return fetchJson(url, { ...init, headers });
}

function fetchLlmJson(url, token, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  return fetchJson(url, { ...init, headers });
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function expectJson(response, action) {
  if (!response.ok) {
    throw new Error(
      `${action} failed (${response.status}): ${(await readResponseText(response)) || response.statusText}`,
    );
  }

  return response.json();
}

const familyFromModelId = (modelId) => String(modelId).split(/[-/]/).filter(Boolean)[0] || modelId;
const providerSpec = (provider) => {
  const [npm, baseURL] = PROVIDERS[provider] || [];
  return npm ? { npm, baseURL } : null;
};

function buildOpenCodeModel(zedModel) {
  const spec = providerSpec(zedModel.provider);
  if (!spec) {
    return null;
  }

  return {
    id: zedModel.id,
    providerID: "zed",
    api: { id: zedModel.id, npm: spec.npm, url: spec.baseURL },
    status: "active",
    name: zedModel.display_name || zedModel.id,
    family: familyFromModelId(zedModel.id),
    capabilities: {
      temperature: true,
      reasoning: Boolean(zedModel.supports_thinking),
      attachment: Boolean(zedModel.supports_images),
      toolcall: Boolean(zedModel.supports_tools),
      input: { text: true, audio: false, image: Boolean(zedModel.supports_images), video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    options: {},
    limit: {
      context: Number(zedModel.max_token_count) || 0,
      output: Number(zedModel.max_output_tokens) || 0,
    },
    headers: {},
    release_date: "",
    variants: {},
  };
}

function buildBootstrapModels() {
  const model = buildOpenCodeModel({
    provider: "open_ai",
    id: "gpt-5-nano",
    display_name: "GPT-5 nano",
    max_token_count: 400000,
    max_output_tokens: 128000,
    supports_tools: true,
    supports_images: true,
    supports_thinking: false,
  });

  return model ? { [model.id]: model } : {};
}

function zedProviderIdFromNpm(npm) {
  for (const [providerId, [providerNpm]] of Object.entries(PROVIDERS)) {
    if (providerNpm === npm) {
      return providerId;
    }
  }

  return null;
}

const capabilitiesToModalities = (capabilities = {}) => ({
  input: MODALITIES.filter((modality) => capabilities.input?.[modality]),
  output: MODALITIES.filter((modality) => capabilities.output?.[modality]),
});

function buildPersistedModelConfig(model) {
  return {
    name: model.name,
    provider: { npm: model.api.npm },
    ...(model.status && model.status !== "active" ? { status: model.status } : {}),
    family: model.family,
    release_date: model.release_date,
    temperature: Boolean(model.capabilities?.temperature),
    reasoning: Boolean(model.capabilities?.reasoning),
    attachment: Boolean(model.capabilities?.attachment),
    tool_call: Boolean(model.capabilities?.toolcall),
    modalities: capabilitiesToModalities(model.capabilities),
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cache_read: model.cost?.cache?.read ?? 0,
      cache_write: model.cost?.cache?.write ?? 0,
    },
    limit: { context: model.limit?.context ?? 0, output: model.limit?.output ?? 0 },
  };
}

function mergePersistedModelConfig(generatedModel, existingModel = {}) {
  return !isObject(existingModel)
    ? generatedModel
    : {
        ...generatedModel,
        ...existingModel,
        provider: merge(generatedModel.provider, existingModel.provider),
        modalities: merge(generatedModel.modalities, existingModel.modalities),
        cost: merge(generatedModel.cost, existingModel.cost),
        limit: merge(generatedModel.limit, existingModel.limit),
      };
}

function mergeOpenCodeModel(baseModel, model) {
  return {
    ...baseModel,
    ...model,
    api: merge(baseModel.api, model?.api),
    capabilities: {
      ...baseModel.capabilities,
      ...(model?.capabilities || {}),
      input: merge(baseModel.capabilities.input, model?.capabilities?.input),
      output: merge(baseModel.capabilities.output, model?.capabilities?.output),
    },
    cost: {
      ...baseModel.cost,
      ...(model?.cost || {}),
      cache: merge(baseModel.cost.cache, model?.cost?.cache),
    },
    limit: merge(baseModel.limit, model?.limit),
    headers: merge(baseModel.headers, model?.headers),
    options: merge(baseModel.options, model?.options),
    variants: merge(baseModel.variants, model?.variants),
  };
}

function mergeBootstrapModels(existingModels = {}) {
  const bootstrapModels = buildBootstrapModels();
  return Object.entries(existingModels).reduce(
    (models, [modelId, model]) => ({
      ...models,
      [modelId]: bootstrapModels[modelId] && isObject(model)
        ? mergeOpenCodeModel(bootstrapModels[modelId], model)
        : model,
    }),
    { ...bootstrapModels },
  );
}

function buildRuntimeModelFromProviderModel(modelId, model) {
  const provider = zedProviderIdFromNpm(model?.api?.npm || model?.provider?.npm);
  return provider
    ? {
        id: model?.api?.id || modelId,
        provider,
        display_name: model?.name || modelId,
        max_token_count: Number(model?.limit?.context) || 0,
        max_output_tokens: Number(model?.limit?.output) || 0,
        supports_tools: Boolean(model?.capabilities?.toolcall),
        supports_images: Boolean(model?.capabilities?.attachment || model?.capabilities?.input?.image),
        supports_thinking: Boolean(model?.capabilities?.reasoning),
      }
    : null;
}

function hydrateRuntimeModelsFromProvider(provider, runtimeState) {
  if (!provider?.models) {
    return;
  }

  for (const [modelId, model] of Object.entries(provider.models)) {
    if (runtimeState.zedModelsById.has(modelId)) {
      continue;
    }

    const runtimeModel = buildRuntimeModelFromProviderModel(modelId, model);
    if (runtimeModel) {
      runtimeState.zedModelsById.set(modelId, runtimeModel);
    }
  }
}

function rebuildProviderModels(provider, modelsResponse, runtimeState) {
  runtimeState.zedModelsById.clear();
  const models = {};

  for (const zedModel of modelsResponse.models || []) {
    runtimeState.zedModelsById.set(zedModel.id, zedModel);
    const model = buildOpenCodeModel(zedModel);
    if (model) {
      models[model.id] = model;
    }
  }

  if (provider) {
    provider.models = models;
  }
}

const getPersistedConfigPath = () => path.join(homedir(), ".opencode", "opencode.json");
const getProviderNpm = (provider = {}) =>
  !provider.npm || provider.npm === "@ai-sdk/openai-compatible"
    ? DEFAULTS.providerNpm
    : provider.npm;

async function readPersistedConfig() {
  try {
    return JSON.parse(await readFile(getPersistedConfigPath(), "utf8"));
  } catch {
    return {};
  }
}

async function persistDiscoveredModels(provider, modelsResponse) {
  const discoveredModels = Object.fromEntries(
    (modelsResponse.models || [])
      .map(buildOpenCodeModel)
      .filter(Boolean)
      .map((model) => [model.id, buildPersistedModelConfig(model)]),
  );

  if (Object.keys(discoveredModels).length === 0) {
    return;
  }

  const config = await readPersistedConfig();
  const existingProvider = config.provider?.zed || {};
  const mergedModels = Object.fromEntries(
    Object.entries(discoveredModels).map(([modelId, generatedModel]) => [
      modelId,
      mergePersistedModelConfig(generatedModel, existingProvider.models?.[modelId]),
    ]),
  );

  config.provider ||= {};
  config.provider.zed = {
    ...existingProvider,
    name: existingProvider.name || "Zed",
    npm: getProviderNpm(existingProvider),
    api: existingProvider.api || DEFAULTS.llmUrl,
    options: {
      serverUrl: DEFAULTS.serverUrl,
      cloudUrl: DEFAULTS.cloudUrl,
      llmUrl: DEFAULTS.llmUrl,
      ...(existingProvider.options || {}),
      ...(provider?.options || {}),
    },
    models: mergedModels,
  };

  const configPath = getPersistedConfigPath();
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

const getPreferredOrganizationId = (provider) =>
  provider?.options?.organizationId || process.env.ZED_ORGANIZATION_ID || null;

function getSystemId(provider, runtimeState) {
  if (!runtimeState.systemId) {
    runtimeState.systemId =
      provider?.options?.systemId || process.env.ZED_SYSTEM_ID || randomUUID();
  }

  return runtimeState.systemId;
}

const getZedVersion = (provider) =>
  provider?.options?.appVersion || process.env.ZED_APP_VERSION || DEFAULTS.zedVersion;

async function fetchAuthenticatedUser(credentials, urls) {
  return expectJson(
    await fetchAuthenticatedJson(buildUrl(urls.cloudUrl, "/client/users/me"), credentials),
    "Fetching Zed account",
  );
}

async function createLlmToken(credentials, urls, organizationId, systemId) {
  const response = await fetchAuthenticatedJson(
    buildUrl(urls.cloudUrl, "/client/llm_tokens"),
    credentials,
    {
      method: "POST",
      headers: { [HEADERS.systemId]: systemId },
      body: JSON.stringify({ organization_id: organizationId || null }),
    },
  );
  return (await expectJson(response, "Creating Zed LLM token")).token;
}

async function listZedModels(token, urls) {
  return expectJson(
    await fetchLlmJson(buildUrl(urls.llmUrl, "/models"), token, {
      headers: { [HEADERS.supportsXai]: "true" },
    }),
    "Listing Zed models",
  );
}

const extractModelIdFromGooglePath = (url) => url.pathname.match(/\/models\/([^/:?]+)(?::[^/?]+)?/)?.[1] || null;
const normalizeGoogleModelValue = (value) =>
  typeof value === "string" && value ? value.replace(/^models\//, "") : null;

function getRequestUrl(requestInput) {
  return requestInput instanceof URL
    ? requestInput
    : requestInput instanceof Request
      ? new URL(requestInput.url)
      : new URL(String(requestInput));
}

async function getRequestBodyText(requestInput, init) {
  if (typeof init?.body === "string") {
    return init.body;
  }
  if (init?.body instanceof Uint8Array || init?.body instanceof ArrayBuffer) {
    return Buffer.from(init.body).toString("utf8");
  }
  if (init?.body && typeof init.body === "object" && !(init.body instanceof ReadableStream)) {
    return JSON.stringify(init.body);
  }
  return requestInput instanceof Request ? requestInput.clone().text() : "";
}

function getRequestHeaders(requestInput, init) {
  const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

async function parseProviderRequest(requestInput, init, runtimeState) {
  const url = getRequestUrl(requestInput);
  const body = parseJson(await getRequestBodyText(requestInput, init), {});
  const requestHeaders = getRequestHeaders(requestInput, init);
  const modelId = normalizeGoogleModelValue(body.model) || extractModelIdFromGooglePath(url);
  const zedModel = modelId ? runtimeState.zedModelsById.get(modelId) : null;

  if (!zedModel) {
    throw new Error(`Unable to match Zed model for request to ${url.toString()}`);
  }

  body.model = zedModel.provider === "google" ? `models/${zedModel.id}` : body.model || zedModel.id;
  return { body, requestHeaders, zedModel };
}

const normalizeOpenAiMessageRole = (role) => (role === "developer" ? "system" : OPENAI_ROLES.has(role) ? role : null);

const OPENAI_CONTENT_NORMALIZERS = {
  input_text: (part) => (typeof part.text === "string" ? { type: "input_text", text: part.text } : null),
  output_text: (part) =>
    typeof part.text === "string"
      ? {
          type: "output_text",
          text: part.text,
          annotations: Array.isArray(part.annotations) ? part.annotations : [],
        }
      : null,
  input_image: (part) => (typeof part.image_url === "string" ? { type: "input_image", image_url: part.image_url } : null),
  refusal: (part) => (typeof part.refusal === "string" ? { type: "refusal", refusal: part.refusal } : null),
};

function normalizeOpenAiContentPart(role, part) {
  if (typeof part === "string") {
    return role === "assistant"
      ? { type: "output_text", text: part, annotations: [] }
      : { type: "input_text", text: part };
  }

  return isObject(part) ? OPENAI_CONTENT_NORMALIZERS[part.type]?.(part) || null : null;
}

function normalizeOpenAiMessageContent(role, content) {
  if (typeof content === "string") {
    const part = normalizeOpenAiContentPart(role, content);
    return part ? [part] : [];
  }

  return Array.isArray(content)
    ? content.map((part) => normalizeOpenAiContentPart(role, part)).filter(Boolean)
    : [];
}

function normalizeOpenAiInputItem(item) {
  if (!isObject(item)) {
    return null;
  }

  if (item.type === "function_call") {
    return typeof item.call_id === "string" && typeof item.name === "string"
      ? {
          type: "function_call",
          call_id: item.call_id,
          name: item.name,
          arguments: stringify(item.arguments),
        }
      : null;
  }

  if (item.type === "function_call_output") {
    return typeof item.call_id === "string"
      ? {
          type: "function_call_output",
          call_id: item.call_id,
          output: stringify(item.output),
        }
      : null;
  }

  const role = normalizeOpenAiMessageRole(item.role);
  const content = role ? normalizeOpenAiMessageContent(role, item.content) : [];
  return role && content.length > 0 ? { type: "message", role, content } : null;
}

function normalizeOpenAiTool(tool) {
  return !isObject(tool) || tool.type !== "function" || typeof tool.name !== "string"
    ? null
    : compact({
        type: "function",
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : undefined,
        parameters: isObject(tool.parameters) ? tool.parameters : undefined,
        strict: typeof tool.strict === "boolean" ? tool.strict : undefined,
      });
}

const normalizeOpenAiToolChoice = (toolChoice) =>
  OPENAI_TOOL_CHOICES.has(toolChoice) ? toolChoice : undefined;

function normalizeOpenAiReasoning(reasoning) {
  return isObject(reasoning) && typeof reasoning.effort === "string"
    ? compact({
        effort: reasoning.effort,
        summary: typeof reasoning.summary === "string" ? reasoning.summary : undefined,
      })
    : undefined;
}

function normalizeOpenAiProviderRequest(body, threadId, zedModel) {
  const input = Array.isArray(body.input) ? body.input.map(normalizeOpenAiInputItem).filter(Boolean) : [];
  const tools = Array.isArray(body.tools) ? body.tools.map(normalizeOpenAiTool).filter(Boolean) : [];

  return compact({
    model: typeof body.model === "string" ? body.model : undefined,
    input,
    stream: body.stream !== false,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    top_p: typeof body.top_p === "number" ? body.top_p : undefined,
    max_output_tokens: typeof body.max_output_tokens === "number" ? body.max_output_tokens : undefined,
    parallel_tool_calls:
      tools.length > 0 && typeof body.parallel_tool_calls === "boolean"
        ? body.parallel_tool_calls
        : undefined,
    tool_choice: normalizeOpenAiToolChoice(body.tool_choice),
    tools: tools.length > 0 ? tools : undefined,
    prompt_cache_key:
      typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : threadId || undefined,
    reasoning: zedModel?.supports_thinking ? normalizeOpenAiReasoning(body.reasoning) : undefined,
  });
}

function normalizeStreamLine(line) {
  const trimmedLine = line.trim();
  if (!trimmedLine) {
    return null;
  }

  const parsed = parseJson(trimmedLine);
  if (isObject(parsed)) {
    if (isObject(parsed.event)) {
      return JSON.stringify(parsed.event);
    }
    if (parsed.status) {
      return null;
    }
  }

  return trimmedLine;
}

function streamJsonLinesAsSse(response) {
  if (!response.body) {
    return response;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  const stream = new ReadableStream({
    async pull(controller) {
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
          buffer = buffer.slice(newlineIndex + 1);
          const normalizedLine = normalizeStreamLine(line);
          if (normalizedLine) {
            controller.enqueue(encoder.encode(`data: ${normalizedLine}\n\n`));
            return;
          }
          continue;
        }

        const { done, value } = await reader.read();
        if (done) {
          const tail = normalizeStreamLine(buffer);
          if (tail) {
            controller.enqueue(encoder.encode(`data: ${tail}\n\n`));
          }
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {}
    },
  });

  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  headers.delete("Content-Length");
  return new Response(stream, { status: response.status, statusText: response.statusText, headers });
}

async function sendCompletionRequest({ requestInput, init, runtimeState, urls, llmToken, zedVersion }) {
  const { body, requestHeaders, zedModel } = await parseProviderRequest(requestInput, init, runtimeState);
  const threadId = requestHeaders.get(HEADERS.threadId) || undefined;
  const promptId = requestHeaders.get(HEADERS.promptId) || undefined;
  const intent = requestHeaders.get(HEADERS.intent) || undefined;
  const signal = init?.signal ?? (requestInput instanceof Request ? requestInput.signal : undefined);
  const providerRequest =
    zedModel.provider === "open_ai" ? normalizeOpenAiProviderRequest(body, threadId, zedModel) : body;

  if (zedModel.provider === "open_ai") {
    debugLog("openai provider_request summary", {
      keys: Object.keys(providerRequest),
      inputCount: Array.isArray(providerRequest.input) ? providerRequest.input.length : 0,
      inputRoles: Array.isArray(providerRequest.input)
        ? providerRequest.input.map((item) => item?.role || item?.type || "unknown").slice(0, 8)
        : [],
      toolCount: Array.isArray(providerRequest.tools) ? providerRequest.tools.length : 0,
      toolChoice: providerRequest.tool_choice || null,
      hasReasoning: Boolean(providerRequest.reasoning),
    });
  }

  return fetch(buildUrl(urls.llmUrl, "/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${llmToken}`,
      "Content-Type": "application/json",
      [HEADERS.version]: zedVersion,
      [HEADERS.supportsStatusMessages]: "true",
      [HEADERS.supportsStreamEndedStatus]: "true",
    },
    body: JSON.stringify({
      ...(threadId ? { thread_id: threadId } : {}),
      ...(promptId ? { prompt_id: promptId } : {}),
      intent: intent || "user_prompt",
      provider: zedModel.provider,
      model: zedModel.id,
      provider_request: providerRequest,
    }),
    signal,
  });
}

const createRuntimeState = () => ({
  llmToken: null,
  organizationId: undefined,
  systemId: null,
  zedModelsById: new Map(),
  lastRefreshKey: null,
  warmupTask: null,
});

function resetRuntime(runtimeState, provider) {
  runtimeState.llmToken = null;
  runtimeState.organizationId = undefined;
  runtimeState.zedModelsById.clear();
  hydrateRuntimeModelsFromProvider(provider, runtimeState);
}

async function ensureLlmToken(runtimeState, credentials, urls, preferredOrganizationId, systemId) {
  try {
    runtimeState.llmToken = await createLlmToken(credentials, urls, runtimeState.organizationId, systemId);
  } catch (error) {
    if (preferredOrganizationId) {
      throw error;
    }

    const fallbackOrganizationId = (await fetchAuthenticatedUser(credentials, urls)).organizations?.[0]?.id || null;
    if (fallbackOrganizationId === runtimeState.organizationId) {
      throw error;
    }

    runtimeState.organizationId = fallbackOrganizationId;
    runtimeState.llmToken = await createLlmToken(credentials, urls, fallbackOrganizationId, systemId);
  }
}

async function refreshRuntime(runtimeState, getAuth, provider, options = {}) {
  const { refreshModels = false, forceToken = false } = options;
  const urls = getConfiguredUrls(provider?.options);
  const credentials = await resolveZedCredentials(await getAuth(), urls);
  const refreshKey = `${credentials.userId}:${credentials.accessToken}`;
  const preferredOrganizationId = getPreferredOrganizationId(provider);
  const systemId = getSystemId(provider, runtimeState);

  hydrateRuntimeModelsFromProvider(provider, runtimeState);

  if (runtimeState.lastRefreshKey !== refreshKey) {
    runtimeState.lastRefreshKey = refreshKey;
    resetRuntime(runtimeState, provider);
  }

  if (runtimeState.organizationId === undefined) {
    runtimeState.organizationId = preferredOrganizationId || null;
  }
  if (!runtimeState.llmToken || forceToken) {
    await ensureLlmToken(runtimeState, credentials, urls, preferredOrganizationId, systemId);
  }
  if (refreshModels || runtimeState.zedModelsById.size === 0) {
    const modelsResponse = await listZedModels(runtimeState.llmToken, urls);
    rebuildProviderModels(provider, modelsResponse, runtimeState);
    await persistDiscoveredModels(provider, modelsResponse);
  }

  return { urls, zedVersion: getZedVersion(provider) };
}

function warmRuntime(runtimeState, getAuth, provider, options = {}) {
  if (runtimeState.warmupTask) {
    return runtimeState.warmupTask;
  }

  const task = refreshRuntime(runtimeState, getAuth, provider, options).finally(() => {
    if (runtimeState.warmupTask === task) {
      runtimeState.warmupTask = null;
    }
  });

  runtimeState.warmupTask = task;
  return task;
}

const shouldRefreshToken = (response) =>
  response.status === 401 ||
  Boolean(response.headers.get(HEADERS.expiredToken)) ||
  Boolean(response.headers.get(HEADERS.outdatedToken));

function buildProviderConfig(existing = {}) {
  return {
    name: existing.name || "Zed",
    npm: getProviderNpm(existing),
    options: {
      serverUrl: DEFAULTS.serverUrl,
      cloudUrl: DEFAULTS.cloudUrl,
      llmUrl: DEFAULTS.llmUrl,
      ...(existing.options || {}),
    },
    models: mergeBootstrapModels(existing.models || {}),
  };
}

function getZedFetch(runtimeState, getAuth, provider) {
  return async function zedFetch(requestInput, init) {
    await runtimeState.warmupTask?.catch(() => {});

    let runtime = await refreshRuntime(runtimeState, getAuth, provider, {
      refreshModels: runtimeState.zedModelsById.size === 0,
    });

    debugLog("zedFetch runtime ready", {
      modelCount: runtimeState.zedModelsById.size,
      llmTokenReady: Boolean(runtimeState.llmToken),
    });

    let response = await sendCompletionRequest({
      requestInput,
      init,
      runtimeState,
      urls: runtime.urls,
      llmToken: runtimeState.llmToken,
      zedVersion: runtime.zedVersion,
    });

    if (shouldRefreshToken(response)) {
      runtime = await refreshRuntime(runtimeState, getAuth, provider, { forceToken: true });
      response = await sendCompletionRequest({
        requestInput,
        init,
        runtimeState,
        urls: runtime.urls,
        llmToken: runtimeState.llmToken,
        zedVersion: runtime.zedVersion,
      });
    }

    return response.ok ? streamJsonLinesAsSse(response) : response;
  };
}

function getAuthMethods() {
  return [
    {
      type: "api",
      label: "Use local Zed desktop credentials (Linux)",
      async authorize() {
        const credentials = await readLocalZedCredentials(getConfiguredUrls());
        return credentials ? { type: "success", key: JSON.stringify(credentials) } : { type: "failed" };
      },
    },
    {
      type: "api",
      label: "Paste Zed credentials",
      prompts: [
        {
          type: "text",
          key: "userId",
          message: "Enter your Zed user id",
          placeholder: "From your local Zed credential entry: attribute.username",
          validate: (value) => (!value.trim() ? "User id is required" : undefined),
        },
        {
          type: "text",
          key: "accessToken",
          message: "Enter your Zed credential secret",
          placeholder: "Paste the full value after `secret =` from `secret-tool`",
          validate: (value) => (!value.trim() ? "Credential secret is required" : undefined),
        },
      ],
      async authorize(inputs = {}) {
        const userId = inputs.userId?.trim();
        const accessToken = inputs.accessToken?.trim();
        return userId && accessToken
          ? {
              type: "success",
              key: JSON.stringify({
                userId,
                accessToken: normalizeAccessToken(accessToken),
              }),
            }
          : { type: "failed" };
      },
    },
  ];
}

/**
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function ZedAuthPlugin() {
  const runtimeState = createRuntimeState();

  return {
    async config(config) {
      config.provider ||= {};
      config.provider.zed = buildProviderConfig(config.provider.zed || {});
    },
    auth: {
      provider: "zed",
      async loader(getAuth, provider) {
        debugLog("loader start", {
          hasProvider: Boolean(provider),
          modelCount: Object.keys(provider?.models || {}).length,
        });

        hydrateRuntimeModelsFromProvider(provider, runtimeState);
        warmRuntime(runtimeState, getAuth, provider).catch((error) => {
          debugLog("loader warmup failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });

        debugLog("loader initialized", {
          modelCount: Object.keys(provider?.models || {}).length,
          cachedModelCount: runtimeState.zedModelsById.size,
        });

        return {
          baseURL: PROVIDERS.open_ai[1],
          apiKey: DEFAULTS.apiKey,
          fetch: getZedFetch(runtimeState, getAuth, provider),
        };
      },
      methods: getAuthMethods(),
    },
    async "chat.headers"(input, output) {
      if (input.model.providerID !== "zed") {
        return;
      }

      output.headers[HEADERS.threadId] = input.sessionID;
      output.headers[HEADERS.promptId] = input.message.id;
      output.headers[HEADERS.intent] = "user_prompt";
    },
  };
}

export default ZedAuthPlugin;
