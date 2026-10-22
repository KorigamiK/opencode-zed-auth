import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../src/plugin.js";

const turn = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  for (let i = 0; i < 20; i++) await turn();
}

async function setup(t, { status, reject = false, hold = false } = {}) {
  let connection = { type: "credential", id: "zed-account", method: "key", status };
  let value = { type: "key", key: JSON.stringify({ userId: "user", accessToken: "original" }) };
  const events = [];
  let wake;
  const emit = (event = { type: "credential.updated", data: {} }) => {
    events.push(event);
    wake?.();
    wake = undefined;
  };
  const calls = { models: 0, status: 0, logs: 0, tokens: 0 };
  let release;
  const gate = hold ? new Promise((resolve) => { release = resolve; }) : undefined;
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalDebug = process.env.OPENCODE_ZED_DEBUG;
  delete process.env.OPENCODE_ZED_DEBUG;
  console.info = () => { calls.logs++; };
  console.warn = () => {};
  globalThis.fetch = async (url) => {
    if (new URL(url).pathname === "/client/llm_tokens") {
      calls.tokens++;
      if (reject) return new Response(null, { status: 401 });
      return Response.json({ token: "llm-token" });
    }
    calls.models++;
    await gate;
    return Response.json({ models: [{ id: "test-model", provider: "open_ai" }] });
  };
  const cleanup = await plugin.setup({
    options: {},
    provider: { transform: async () => {}, get: async () => ({ data: { settings: {} } }), reload: async () => {} },
    integration: {
      transform: async () => {},
      connection: {
        active: async () => connection,
        resolve: async () => value,
        status: async (input) => {
          calls.status++;
          connection = { ...connection, status: input.status };
          // OpenCode emits this for connection status changes, too.
          emit();
        },
      },
    },
    storage: { get: async () => undefined, set: async () => {} },
    session: { hook: async () => {} },
    event: {
      subscribe: async function* ({ signal }) {
        signal.addEventListener("abort", () => wake?.(), { once: true });
        while (!signal.aborted) {
          if (!events.length) await new Promise((resolve) => { wake = resolve; });
          if (signal.aborted) return;
          yield events.shift();
        }
      },
    },
  });
  t.after(async () => {
    cleanup();
    release?.();
    await settle();
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
    console.warn = originalWarn;
    if (originalDebug === undefined) delete process.env.OPENCODE_ZED_DEBUG;
    else process.env.OPENCODE_ZED_DEBUG = originalDebug;
  });
  // Let the plugin's deferred startup discovery run.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await settle();
  return {
    calls, emit, release,
    update: (accessToken) => { value = { ...value, key: JSON.stringify({ userId: "user", accessToken }) }; emit(); },
    switchAccount: () => {
      connection = { ...connection, id: "other-account" };
      emit({ type: "credential.switched", data: { integrationID: "zed", credentialID: connection.id } });
    },
  };
}

test("healthy startup stays quiet and ignores unchanged credential notifications", async (t) => {
  const { calls, emit } = await setup(t);
  for (let i = 0; i < 5; i++) emit();
  emit({ type: "credential.switched", data: { integrationID: "other-provider" } });
  await settle();
  assert.deepEqual(calls, { models: 1, status: 0, logs: 0, tokens: 1 });
});

test("clearing an auth warning does not cause another catalog discovery", async (t) => {
  const { calls } = await setup(t, { status: { status: "needs_auth", message: "Old warning" } });
  assert.deepEqual(calls, { models: 1, status: 1, logs: 0, tokens: 1 });
});

test("switching the active Zed account refreshes its catalog", async (t) => {
  const { calls, switchAccount } = await setup(t);
  switchAccount();
  await settle();
  assert.equal(calls.models, 2);
});

test("the five-minute timer still refreshes an unchanged credential", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { calls } = await setup(t);
  t.mock.timers.tick(5 * 60_000);
  await settle();
  assert.equal(calls.models, 2);
});

test("a credential change during discovery refreshes once with the new credential", async (t) => {
  const { calls, update, release } = await setup(t, { hold: true });
  update("replacement");
  await settle();
  release();
  await settle();
  assert.equal(calls.models, 2);
  assert.equal(calls.tokens, 2);
  update("replacement");
  await settle();
  assert.equal(calls.models, 2);
});

test("a rejected credential is retried only after its value changes", async (t) => {
  const { calls, emit, update } = await setup(t, { reject: true });
  emit();
  await settle();
  assert.equal(calls.tokens, 1);
  assert.equal(calls.status, 1);
  update("replacement");
  await settle();
  assert.equal(calls.tokens, 2);
  assert.equal(calls.status, 2);
});
