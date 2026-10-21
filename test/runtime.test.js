import test from "node:test";
import assert from "node:assert/strict";
import plugin, { buildModel, catalogCacheKey } from "../src/plugin.js";
import { PACKAGES, ZedRuntime, ZedHttpError, configuredUrls, normalizeAccessToken, normalizeOpenAiRequest, parseCredentials, shouldRefreshToken, streamAsSse } from "../src/cloud.js";

const secret = { version: 2, id: "token-id", token: "test-secret" };
const saved = { userId: "user-id", accessToken: JSON.stringify(secret) };
const credential = { type: "key", key: JSON.stringify(saved) };
const model = { id: "test-gpt", provider: "open_ai", supports_thinking: true, supports_tools: true, supports_images: true };
const json = (value, init) => new Response(JSON.stringify(value), init);

test("JSON is the credential, not an ordinary API key", () => {
  assert.deepEqual(parseCredentials(credential), saved);
  assert.deepEqual(parseCredentials({ ...credential, type: "api" }), saved);
  assert.deepEqual(parseCredentials({ type: "key", key: `${saved.userId} ${saved.accessToken}` }), saved);
  assert.equal(normalizeAccessToken({ id: 42, token: "secret" }), '{"version":2,"id":"42","token":"secret"}');
  assert.throws(() => parseCredentials({ type: "key", key: "ordinary-key" }), /invalid/);
});

test("endpoint overrides and staging defaults are preserved", () => {
  assert.equal(configuredUrls().cloudUrl, "https://cloud.zed.dev");
  assert.equal(configuredUrls({ serverUrl: "https://staging.zed.dev" }).llmUrl, "https://llm-staging.zed.dev");
  assert.equal(configuredUrls({ cloudUrl: "https://cloud.example/", llmUrl: "https://llm.example/" }).llmUrl, "https://llm.example");
});

test("concurrent requests mint once and never use the JSON as a bearer token", async () => {
  let calls = 0;
  const runtime = new ZedRuntime({}, { fetch: async (url, init) => {
    calls++;
    assert.equal(new URL(url).pathname, "/client/llm_tokens");
    assert.equal(init.headers.Authorization, `${saved.userId} ${saved.accessToken}`);
    return json({ token: "llm-token" });
  } });
  assert.deepEqual(await Promise.all([runtime.ensureToken(credential), runtime.ensureToken(credential)]), ["llm-token", "llm-token"]);
  assert.equal(calls, 1);
  await runtime.ensureToken(credential, { force: true });
  assert.equal(calls, 2);
});

test("a rejected credential never triggers a desktop/keychain fallback", async () => {
  let count = 0;
  let keychainCalls = 0;
  const runtime = new ZedRuntime({}, {
    localCredentials: async () => { keychainCalls++; return { ...saved, accessToken: "new-secret" }; },
    fetch: async (url, init) => {
      count++;
      return init.headers.Authorization.endsWith("new-secret") ? json({ token: "new-llm" }) : new Response(null, { status: 401 });
    },
  });
  await assert.rejects(runtime.ensureToken(credential), (error) => error.status === 401);
  await assert.rejects(runtime.ensureToken(credential), (error) => error.status === 401);
  assert.equal(count, 1);
  assert.equal(keychainCalls, 0);
});

test("account switching does not reuse the first account's token", async () => {
  const runtime = new ZedRuntime({}, { fetch: async (url, init) => json({ token: init.headers.Authorization.split(" ")[0] }) });
  const other = { type: "key", key: JSON.stringify({ ...saved, userId: "other-user" }) };
  const tokens = await Promise.all([runtime.ensureToken(credential), runtime.ensureToken(other)]);
  assert.deepEqual(tokens, ["user-id", "other-user"]);
  assert.equal(runtime.token, "other-user");
});

test("organization fallback uses /client/users/me", async () => {
  const runtime = new ZedRuntime({}, { fetch: async (url, init) => {
    if (new URL(url).pathname === "/client/users/me") return json({ organizations: [{ id: "org-id" }] });
    return JSON.parse(init.body).organization_id === "org-id" ? json({ token: "org-llm" }) : new Response(null, { status: 403 });
  } });
  assert.equal(await runtime.ensureToken(credential), "org-llm");
});

test("catalog discovery refreshes an expired LLM token", async () => {
  let mints = 0;
  const runtime = new ZedRuntime({}, { fetch: async (url, init) => {
    if (new URL(url).pathname === "/client/llm_tokens") return json({ token: `llm-${++mints}` });
    return mints === 1 ? new Response(null, { status: 401 }) : json({ models: [model, { id: "unknown", provider: "unsupported" }] });
  } });
  assert.deepEqual(await runtime.discover(credential), [model]);
  assert.equal(mints, 2);
  assert.deepEqual(runtime.models.get(model.id), model);
  for (const key of ["x-zed-expired-token", "x-zed-outdated-token"]) assert.ok(shouldRefreshToken(new Response(null, { headers: { [key]: "true" } })));
});

test("auth errors do not expose the secret or upstream response body", async () => {
  const runtime = new ZedRuntime({}, {
    localCredentials: async () => null,
    fetch: async () => new Response("sensitive upstream response", { status: 401 }),
  });
  await assert.rejects(runtime.ensureToken(credential), (error) => {
    assert.ok(error instanceof ZedHttpError);
    assert.equal(error.status, 401);
    assert.ok(!error.message.includes("sensitive"));
    assert.ok(!error.message.includes(secret.token));
    return true;
  });
});

for (const provider of Object.keys(PACKAGES)) {
  test(`${provider}: request is routed through Zed with only its LLM token`, async () => {
    const runtime = new ZedRuntime({}, { fetch: async () => json({ token: "llm-token" }) });
    const abort = new AbortController();
    const input = new Request("https://never-send.example/v1/responses", {
      method: "POST", headers: { Authorization: "Bearer do-not-leak", "x-api-key": "do-not-leak" },
      body: JSON.stringify({ input: "Hi", messages: [{ role: "user", content: "Hi" }] }), signal: abort.signal,
    });
    const request = await runtime.wrapRequest(input, { ...model, provider }, credential, { sessionID: "session-id" });
    assert.equal(request.url, "https://cloud.zed.dev/completions");
    assert.equal(request.headers.get("Authorization"), "Bearer llm-token");
    assert.equal(request.headers.get("x-api-key"), null);
    const body = await request.json();
    assert.equal(body.thread_id, "session-id");
    assert.equal(body.provider, provider);
    assert.equal(body.model, model.id);
    assert.equal(body.provider_request.model, provider === "google" ? `models/${model.id}` : model.id);
    abort.abort();
    assert.ok(request.signal.aborted);
  });
}

test("OpenAI normalization retains tool calls, tool outputs, reasoning and images", () => {
  const body = { input: [
    { role: "developer", content: "instructions" },
    { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] },
    { type: "reasoning", id: "rs_1", encrypted_content: "encrypted", summary: [] },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "contents" },
  ], tools: [{ type: "function", name: "read", parameters: {} }], store: false, previous_response_id: "old", reasoning: { effort: "high" } };
  const normalized = normalizeOpenAiRequest(body, "thread", model);
  assert.equal(normalized.input[0].role, "system");
  assert.equal(normalized.input[1].content[0].type, "input_image");
  assert.deepEqual(normalized.input[2], body.input[2]);
  assert.equal(normalized.input[3].id, undefined);
  assert.equal(normalized.input[4].output, "contents");
  assert.deepEqual(normalized.tools, body.tools);
  assert.equal(normalized.previous_response_id, undefined);
  assert.deepEqual(normalized.reasoning, { effort: "high" });
});

test("NDJSON becomes valid SSE, preserving split UTF-8 and a final line without newline", async () => {
  const bytes = new TextEncoder().encode('{"status":"started"}\n{"event":{"type":"content_block_delta","text":"hé🙂"}}');
  let index = 0;
  const response = new Response(new ReadableStream({ pull(controller) {
    if (index === bytes.length) controller.close();
    else controller.enqueue(bytes.slice(index, ++index));
  } }), { headers: { "Content-Length": "999", "Content-Encoding": "gzip" } });
  const sse = streamAsSse(response, "anthropic");
  assert.equal(sse.headers.get("Content-Length"), null);
  assert.equal(sse.headers.get("Content-Encoding"), null);
  assert.equal(await sse.text(), 'event: content_block_delta\ndata: {"type":"content_block_delta","text":"hé🙂"}\n\n');
});

test("stream failures are not silently converted into empty successful answers", async () => {
  for (const status of ["failed", { type: "error" }]) {
    await assert.rejects(streamAsSse(json({ status }), "open_ai").text(), /stream failure/);
  }
  await assert.rejects(streamAsSse(new Response("not-json"), "google").text(), /invalid JSON/);
});

test("cancelling the adapted stream cancels the upstream stream", async () => {
  let cancelled = false;
  const source = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await streamAsSse(source, "google").body.cancel();
  assert.ok(cancelled);
});

test("V2 model definitions validate and select the correct native protocols", () => {
  assert.equal(plugin.id, "zed.auth");
  assert.equal(typeof plugin.setup, "function");
  const info = buildModel(model);
  assert.equal(info.package, PACKAGES.open_ai);
  assert.deepEqual(info.capabilities.input, ["text", "image"]);
  assert.deepEqual(info.variants.map((variant) => variant.id), ["low", "medium", "high"]);
});

test("catalog cache is account- and endpoint-specific, not connection-status-specific", () => {
  const urls = configuredUrls();
  const connection = { type: "credential", id: "account-1" };
  const key = catalogCacheKey(connection, urls);
  assert.equal(key, catalogCacheKey({ ...connection, status: { status: "needs_auth" } }, urls));
  assert.notEqual(key, catalogCacheKey({ ...connection, id: "account-2" }, urls));
  assert.notEqual(key, catalogCacheKey(connection, { ...urls, llmUrl: "https://other.example" }));
});

test("plugin restores the latest cached models when live auth fails, and marks the account", async () => {
  const connection = { type: "credential", id: "account-1", method: "key" };
  const latest = { ...model, id: "newly-released-model" };
  let inventory = new Map();
  let provider = { id: "zed", name: "Zed", activation: "enabled", package: PACKAGES.open_ai, settings: {} };
  let transform;
  let status;
  const hooks = new Map();
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const editor = {
    get: () => ({ provider, models: inventory }),
    update: (id, callback) => callback(provider),
    add: ({ info, models }) => { provider = info; inventory = new Map(models.map((m) => [m.id, m])); },
  };
  const ctx = {
    options: {},
    provider: {
      get: async () => ({ data: provider }),
      transform: async (callback) => { transform = callback; callback(editor); },
      reload: async () => transform(editor),
    },
    integration: {
      transform: async () => {},
      connection: {
        active: async () => connection,
        resolve: async () => credential,
        status: async (input) => { status = input.status; finished(); },
      },
    },
    storage: { get: async () => ({ version: 1, models: [latest] }), set: async () => {} },
    session: { hook: async (name, callback) => hooks.set(name, callback) },
    event: { subscribe: async function* () {} },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 401 });
  let cleanup;
  try {
    cleanup = await plugin.setup(ctx);
    await done;
    assert.ok(inventory.has(latest.id));
    assert.equal(status.status, "needs_auth");
    assert.match(status.message, /401/);
    assert.ok(hooks.has("http.request"));
  } finally {
    cleanup?.();
    globalThis.fetch = originalFetch;
  }
});
