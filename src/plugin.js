import { Plugin, Model, Provider } from "@opencode/plugin";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PACKAGES, ZedRuntime, configuredUrls, shouldRefreshToken, streamAsSse } from "./cloud.js";

const PROVIDER_ID = "zed";

export function catalogCacheKey(connection, urls) {
  // Neither secrets nor transient connection status belong in the cache key.
  const account = connection.type === "credential" ? connection.id : connection.name;
  return `catalog/${createHash("sha256").update(JSON.stringify([account, urls.cloudUrl, urls.llmUrl])).digest("hex")}`;
}

export function buildModel(model) {
  return {
    ...Model.Info.default(Provider.ID.make(PROVIDER_ID), Model.ID.make(model.id)),
    name: model.display_name || model.id,
    family: model.id.split("-")[0],
    package: PACKAGES[model.provider],
    capabilities: {
      tools: Boolean(model.supports_tools),
      temperature: model.provider !== "open_ai" || !model.supports_thinking,
      input: model.supports_images ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    limit: { context: Number(model.max_token_count) || 200_000, output: Number(model.max_output_tokens) || 32_000 },
    settings: { transport: "http", encoding: "none" },
    variants: !model.supports_thinking ? [] : model.provider === "open_ai"
      ? ["low", "medium", "high"].map((id) => ({ id, settings: { reasoningEffort: id } }))
      : model.provider === "google"
        ? ["low", "high"].map((id) => ({ id, settings: { thinkingConfig: { thinkingLevel: id, includeThoughts: true } } }))
        : [
            { id: "thinking", settings: { thinking: { type: "enabled", budgetTokens: 10_000 } } },
          ],
  };
}

function runtimeModel(model) {
  const provider = Object.keys(PACKAGES).find((key) => PACKAGES[key] === model.package);
  return provider ? {
    id: model.modelID || model.id,
    provider,
    supports_thinking: Boolean(model.variants?.length),
  } : null;
}

export default Plugin.define({
  id: "zed.auth",
  async setup(ctx) {
    const runtime = new ZedRuntime(ctx.options || {});
    const sourceModels = new Map();
    let discoveredModels;
    let sourceConnection;
    let stopped = false;
    let discoveryTask;
    let refreshRequested;
    let discoveryCredentialKey;
    let loadedCacheKey;
    let blockedConnectionKey;
    const requests = new WeakMap();

    await ctx.provider.transform((editor) => {
      const record = editor.get(PROVIDER_ID);
      if (!record) {
        editor.add({ info: {
          ...Provider.Info.empty(Provider.ID.make(PROVIDER_ID)),
          name: "Zed",
          integrationID: PROVIDER_ID,
          package: PACKAGES.open_ai,
          settings: { baseURL: runtime.urls.llmUrl, apiKey: "zed-cloud", transport: "http", encoding: "none" },
        }, models: [] });
      } else {
        for (const [id, model] of record.models) sourceModels.set(id, model);
        editor.update(PROVIDER_ID, (draft) => {
          draft.integrationID = PROVIDER_ID;
          draft.settings = { ...draft.settings, apiKey: "zed-cloud", transport: "http", encoding: "none" };
        });
      }
      if (discoveredModels) {
        const info = editor.get(PROVIDER_ID).provider;
        const models = discoveredModels.map((model) => {
          const generated = buildModel(model);
          const existing = sourceModels.get(model.id);
          return existing ? {
            ...generated,
            name: existing.name,
            enabled: existing.enabled,
            settings: { ...generated.settings, ...existing.settings },
            headers: existing.headers,
            body: existing.body,
          } : generated;
        });
        editor.add({ info, models, sourceConnection });
      }
    });

    await ctx.integration.transform((editor) => {
      editor.update(PROVIDER_ID, (integration) => { integration.name = "Zed"; });
      editor.method.update({ integrationID: PROVIDER_ID, method: {
        type: "key", label: "Paste Zed credentials JSON (userId + accessToken)",
      } });
      editor.method.update({ integrationID: PROVIDER_ID, method: {
        id: "desktop", type: "command", label: "Use local Zed desktop credentials",
        command: ["node", fileURLToPath(new URL("../script/local-credentials.mjs", import.meta.url))],
      } });
    });

    async function credential() {
      const connection = await ctx.integration.connection.active(PROVIDER_ID);
      const value = connection ? await ctx.integration.connection.resolve(connection) : undefined;
      return { connection, value };
    }

    async function reportAuthFailure(connection) {
      if (!connection) return;
      blockedConnectionKey = catalogCacheKey(connection, runtime.urls);
      await ctx.integration.connection.status({
        integrationID: PROVIDER_ID,
        connection,
        status: { status: "needs_auth", message: "Zed rejected the saved credential (401). Reconnect Zed in /connect. Keychain access is manual only." },
      });
    }

    async function refreshCatalog(credentialChangedOnly = false) {
      if (stopped) return;
      if (discoveryTask) {
        // A scheduled refresh takes precedence over a credential notification.
        refreshRequested = refreshRequested === false ? false : credentialChangedOnly;
        return discoveryTask;
      }
      const task = (async () => {
        let connection;
        try {
          const { data: provider } = await ctx.provider.get({ providerID: PROVIDER_ID });
          runtime.settings = { ...provider.settings, ...ctx.options };
          runtime.urls = configuredUrls(runtime.settings);
          const active = await credential();
          connection = active.connection;
          const { value } = active;
          if (!value) {
            discoveryCredentialKey = undefined;
            return;
          }
          const cacheKey = catalogCacheKey(connection, runtime.urls);
          // credential.updated also covers status changes and other providers.
          // Compare the resolved credential, excluding transient status, so our
          // own status reports cannot trigger another discovery indefinitely.
          const credentialKey = createHash("sha256").update(JSON.stringify([cacheKey, value])).digest("hex");
          if (credentialChangedOnly && discoveryCredentialKey === credentialKey) return;
          if (discoveryCredentialKey !== credentialKey) {
            discoveryCredentialKey = credentialKey;
            blockedConnectionKey = undefined;
            runtime.authError = null;
          }
          if (loadedCacheKey !== cacheKey) {
            loadedCacheKey = cacheKey;
            const cache = await ctx.storage.get(cacheKey);
            if (stopped) return;
            if (cache?.version === 1 && Array.isArray(cache.models) && cache.models.length &&
                cache.models.every((model) => typeof model.id === "string" && PACKAGES[model.provider])) {
              discoveredModels = cache.models;
              sourceConnection = connection;
              runtime.models = new Map(cache.models.map((model) => [model.id, model]));
              await ctx.provider.reload();
            }
          }
          if (blockedConnectionKey === cacheKey) return;
          const models = await runtime.discover(value);
          if (stopped) return;
          const current = await ctx.integration.connection.active(PROVIDER_ID);
          if (!current || catalogCacheKey(current, runtime.urls) !== cacheKey) return;
          discoveredModels = models;
          sourceConnection = connection;
          await ctx.storage.set(cacheKey, { version: 1, fetchedAt: Date.now(), models });
          await ctx.provider.reload();
          if (current.status) {
            await ctx.integration.connection.status({ integrationID: PROVIDER_ID, connection: current, status: undefined });
          }
          if (process.env.OPENCODE_ZED_DEBUG === "1") {
            console.info(`[zed.auth] Loaded ${models.length} Zed models.`);
          }
        } catch (error) {
          if (stopped) return;
          if (error.status === 401) await reportAuthFailure(connection);
          // Do not print credential contents or upstream response bodies.
          console.warn(`[zed.auth] Model discovery: ${error.message}`);
        }
      })();
      discoveryTask = task;
      try { await task; } finally {
        if (discoveryTask === task) discoveryTask = undefined;
        if (refreshRequested !== undefined && !stopped) {
          const credentialChangedOnly = refreshRequested;
          refreshRequested = undefined;
          void refreshCatalog(credentialChangedOnly);
        }
      }
    }

    await ctx.session.hook("http.request", async (event) => {
      const { connection, value } = await credential();
      const { data: models } = await ctx.model.list();
      const modelInfo = models.find((model) => model.providerID === PROVIDER_ID && model.id === event.model.id);
      const model = runtime.models.get(modelInfo?.modelID || event.model.id) || (modelInfo && runtimeModel(modelInfo));
      if (!model) throw new Error(`Zed model is not in the supported catalog: ${event.model.id}`);
      const original = event.request;
      let wrapped;
      try {
        wrapped = await runtime.wrapRequest(original, model, value, event);
      } catch (error) {
        if (error.status === 401) await reportAuthFailure(connection);
        throw error;
      }
      // Keep a private replay copy only for the single token-refresh retry.
      requests.set(wrapped, { original: original.clone(), model, credential: value, connection });
      event.request = wrapped;
    }, { providerID: PROVIDER_ID });

    await ctx.session.hook("http.response", async (event) => {
      const replay = requests.get(event.request);
      requests.delete(event.request);
      if (shouldRefreshToken(event.response) && replay) {
        await event.response.body?.cancel();
        let request;
        try {
          request = await runtime.wrapRequest(replay.original, replay.model, replay.credential, event, true);
        } catch (error) {
          if (error.status === 401) await reportAuthFailure(replay.connection);
          throw error;
        }
        event.response = await fetch(request);
      }
      const model = replay?.model || runtime.models.get(event.model.id);
      event.response = streamAsSse(event.response, model?.provider);
    }, { providerID: PROVIDER_ID });

    // Publish discovery only after setup completes; registry rebuilds must not
    // wait on their own plugin activation. A stale inventory remains usable.
    const initial = setTimeout(() => void refreshCatalog(), 0);
    const timer = setInterval(() => void refreshCatalog(), 5 * 60_000);
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "credential.updated" ||
              event.type === "credential.switched" && event.data.integrationID === PROVIDER_ID) {
            void refreshCatalog(true);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.warn("[zed.auth] Credential event subscription ended.");
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(initial);
      clearInterval(timer);
      controller.abort();
    };
  },
});
