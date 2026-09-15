/**
 * Offline tests for the Volcengine API Gateway provider extension.
 * Run with: npm test  (tsx --test)
 */
import test from "node:test";
import assert from "node:assert/strict";

import extension, {
	CATALOG,
	DEFAULT_BASE_URL,
	PROVIDER_ID,
	STRIP_REASONING_SUMMARY,
	mergeGatewayCatalog,
	normalizeOverflowError,
	refreshGatewayModels,
	resolveBaseUrl,
	rewriteProviderPayload,
	unknownModelConfig,
	type GatewayRefreshContext,
} from "../index.ts";

// ---------------------------------------------------------------------------
// fake pi harness
// ---------------------------------------------------------------------------

interface FakePi {
	pi: {
		registerProvider: (name: unknown, config?: unknown) => void;
		on: (event: string, handler: (...args: never[]) => unknown) => void;
	};
	providers: Map<string, Record<string, unknown>>;
	handlers: Map<string, ((...args: unknown[]) => unknown)[]>;
}

function createFakePi(): FakePi {
	const providers = new Map<string, Record<string, unknown>>();
	const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
	return {
		pi: {
			registerProvider(name: unknown, config?: unknown) {
				providers.set(String(name), config as Record<string, unknown>);
			},
			on(event: string, handler: (...args: never[]) => unknown) {
				const list = handlers.get(event) ?? [];
				list.push(handler as (...args: unknown[]) => unknown);
				handlers.set(event, list);
			},
		},
		providers,
		handlers,
	};
}

function loadExtension(): FakePi {
	const fake = createFakePi();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(extension as any)(fake.pi);
	return fake;
}

// ---------------------------------------------------------------------------
// registration shape
// ---------------------------------------------------------------------------

test("registers one provider with responses-first config", () => {
	const fake = loadExtension();
	assert.equal(fake.providers.size, 1);
	const config = fake.providers.get(PROVIDER_ID);
	assert.ok(config, "provider registered under volcengine-gateway");
	assert.equal(config.name, "Volcengine API Gateway");
	assert.equal(config.baseUrl, DEFAULT_BASE_URL);
	assert.equal(config.apiKey, "$VOLCEAPI_API_KEY");
	assert.equal(config.api, "openai-responses");
	assert.ok(Array.isArray(config.models));
	assert.equal((config.models as unknown[]).length, CATALOG.length);
	assert.equal(typeof config.refreshModels, "function");
});

test("registers payload + message_end hooks", () => {
	const fake = loadExtension();
	assert.equal(fake.handlers.get("before_provider_request")?.length, 1);
	assert.equal(fake.handlers.get("message_end")?.length, 1);
});

test("resolveBaseUrl honors env override and strips trailing slashes", () => {
	assert.equal(resolveBaseUrl({} as NodeJS.ProcessEnv), DEFAULT_BASE_URL);
	assert.equal(
		resolveBaseUrl({ VOLCEAPI_BASE_URL: "https://example.com/v1//" } as NodeJS.ProcessEnv),
		"https://example.com/v1",
	);
});

// ---------------------------------------------------------------------------
// catalog invariants (probe-verified 2026-09-15)
// ---------------------------------------------------------------------------

test("catalog covers the full gateway listing with unique ids", () => {
	const ids = CATALOG.map((m) => m.id);
	assert.equal(new Set(ids).size, ids.length, "ids unique");
	assert.equal(ids.length, 15);
	for (const id of [
		"deepseek-v4-flash",
		"deepseek-v4-pro",
		"doubao-seed-2.1-pro",
		"glm-5.2",
		"glm-5.3",
		"glm-5.3-flash",
		"qwen3.7-max",
		"qwen3.7-plus",
		"qwen3.8-flash",
		"qwen3.8-max",
		"kimi-k2.7-code",
		"kimi-k3",
		"MiniMax-M3",
		"hy3",
		"zhipu/glm-5.3",
	]) {
		assert.ok(ids.includes(id), `missing model ${id}`);
	}
});

test("api split: 10 responses models, 5 chat-completions models", () => {
	const chat = CATALOG.filter((m) => m.api === "openai-completions").map((m) => m.id);
	assert.deepEqual(chat.sort(), ["MiniMax-M3", "hy3", "kimi-k2.7-code", "kimi-k3", "zhipu/glm-5.3"].sort());
	for (const model of CATALOG) {
		if (!chat.includes(model.id)) {
			assert.equal(model.api, undefined, `${model.id} inherits provider api openai-responses`);
		}
	}
});

test("every model has sane numeric metadata", () => {
	for (const model of CATALOG) {
		assert.ok(model.contextWindow > 0, `${model.id} contextWindow`);
		assert.ok(model.maxTokens > 0, `${model.id} maxTokens`);
		assert.ok(model.maxTokens <= 1_048_576, `${model.id} maxTokens sane`);
		assert.equal(model.reasoning, true, `${model.id} is a reasoning model`);
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			assert.equal(typeof model.cost[field], "number", `${model.id} cost.${field}`);
			assert.ok(model.cost[field] >= 0);
		}
		for (const modality of model.input) {
			assert.ok(modality === "text" || modality === "image", `${model.id} input modality`);
		}
		assert.ok(model.name.length > 0, `${model.id} display name`);
	}
});

test("vision only on probe-verified models", () => {
	const vision = CATALOG.filter((m) => m.input.includes("image")).map((m) => m.id);
	assert.deepEqual(vision.sort(), [
		"MiniMax-M3",
		"doubao-seed-2.1-pro",
		"glm-5.3-flash",
		"kimi-k2.7-code",
		"kimi-k3",
		"qwen3.7-plus",
		"qwen3.8-flash",
		"qwen3.8-max",
	].sort());
});

test("thinking maps encode the verified gateway quirks", () => {
	const byId = new Map(CATALOG.map((m) => [m.id, m]));
	const map = (id: string) => byId.get(id)!.thinkingLevelMap as Record<string, string | null>;

	// glm-5.3 family + zhipu: always-think models expose only low/high/max
	for (const id of ["glm-5.3", "glm-5.3-flash", "zhipu/glm-5.3"]) {
		assert.equal(map(id).off, null, `${id}: thinking cannot be disabled`);
		assert.equal(map(id).medium, null, `${id}: medium rejected by gateway`);
		assert.equal(map(id).low, "low");
		assert.equal(map(id).high, "high");
		assert.equal(map(id).max, "max");
	}
	// full-control responses families can reach "none"
	for (const id of ["deepseek-v4-flash", "deepseek-v4-pro", "doubao-seed-2.1-pro", "glm-5.2", "qwen3.8-flash"]) {
		assert.equal(map(id).off, "none", `${id}: off maps to effort none`);
	}
	// kimi: only a nominal high, nothing steerable
	const kimi = map("kimi-k2.7-code");
	assert.equal(kimi.off, null);
	assert.equal(kimi.high, "high");
	assert.equal(kimi.low, null);

	// summary-stripping set matches the models that 400 on reasoning.summary
	assert.deepEqual(
		[...STRIP_REASONING_SUMMARY].sort(),
		["deepseek-v4-flash", "doubao-seed-2.1-pro", "glm-5.2"].sort(),
	);

	// chat models needing format help
	const minimax = byId.get("MiniMax-M3")!.compat as Record<string, unknown>;
	assert.equal(minimax.thinkingFormat, "deepseek");
	assert.equal(minimax.supportsReasoningEffort, false);
	const hy3 = byId.get("hy3")!.compat as Record<string, unknown>;
	assert.equal(hy3.thinkingFormat, "deepseek");
	const zhipu = byId.get("zhipu/glm-5.3")!.compat as Record<string, unknown>;
	assert.equal(zhipu.supportsReasoningEffort, true);
});

// ---------------------------------------------------------------------------
// before_provider_request payload rewriting
// ---------------------------------------------------------------------------

test("strips reasoning.summary for rejecting responses models", () => {
	for (const model of ["deepseek-v4-flash", "doubao-seed-2.1-pro", "glm-5.2"]) {
		const payload = {
			model,
			input: [{ role: "user", content: "hi" }],
			stream: true,
			store: false,
			reasoning: { effort: "high", summary: "auto" },
			include: ["reasoning.encrypted_content"],
			max_output_tokens: 4096,
		};
		const rewritten = rewriteProviderPayload(payload) as typeof payload;
		assert.ok(rewritten, `${model}: payload rewritten`);
		assert.deepEqual(rewritten.reasoning, { effort: "high" });
		assert.deepEqual(rewritten.include, ["reasoning.encrypted_content"]);
		assert.equal(rewritten.max_output_tokens, 4096);
		assert.deepEqual(payload.reasoning, { effort: "high", summary: "auto" }, "original untouched");
	}
});

test("leaves summary-accepting responses models alone", () => {
	for (const model of ["deepseek-v4-pro", "glm-5.3", "qwen3.8-max"]) {
		const payload = {
			model,
			input: [],
			store: false,
			reasoning: { effort: "high", summary: "auto" },
		};
		assert.equal(rewriteProviderPayload(payload), undefined, model);
	}
});

test("rewrites MiniMax thinking enabled -> adaptive only", () => {
	const enabled = { model: "MiniMax-M3", messages: [], thinking: { type: "enabled" } };
	const rewritten = rewriteProviderPayload(enabled) as typeof enabled;
	assert.deepEqual(rewritten?.thinking, { type: "adaptive" });

	assert.equal(rewriteProviderPayload({ model: "MiniMax-M3", messages: [], thinking: { type: "disabled" } }), undefined);
	assert.equal(rewriteProviderPayload({ model: "MiniMax-M3", messages: [] }), undefined);
	assert.equal(rewriteProviderPayload({ model: "hy3", messages: [], thinking: { type: "enabled" } }), undefined);
});

test("ignores foreign and malformed payloads", () => {
	assert.equal(rewriteProviderPayload(undefined), undefined);
	assert.equal(rewriteProviderPayload("nope"), undefined);
	assert.equal(rewriteProviderPayload({ messages: [] }), undefined);
	// openai's own responses payload with an unrelated model id
	assert.equal(
		rewriteProviderPayload({ model: "gpt-5.5", input: [], store: false, reasoning: { effort: "high", summary: "auto" } }),
		undefined,
	);
});

test("registered hook passes rewrites through and keeps payloads otherwise", () => {
	const fake = loadExtension();
	const hook = fake.handlers.get("before_provider_request")![0];
	const foreign = { model: "gpt-5.5", input: [], store: false };
	assert.equal(hook({ type: "before_provider_request", payload: foreign }), undefined);
	const minimax = { model: "MiniMax-M3", messages: [], thinking: { type: "enabled" } };
	assert.deepEqual((hook({ type: "before_provider_request", payload: minimax }) as { thinking: { type: string } }).thinking, {
		type: "adaptive",
	});
});

// ---------------------------------------------------------------------------
// message_end overflow normalization
// ---------------------------------------------------------------------------

test("normalizeOverflowError maps gateway overflow phrasing", () => {
	const cases = [
		"Total tokens of image and text exceed max message tokens. Request id: 0217",
		"Input tokens exceed the configured limit of 192000 tokens.",
		"<400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 258048]",
		"OutofContextError: context length exceeded",
		"Messages exceed max message tokens: 12345",
	];
	for (const message of cases) {
		assert.equal(normalizeOverflowError(message), `context_length_exceeded: ${message}`, message);
	}
});

test("normalizeOverflowError never touches rate limits or other errors", () => {
	for (const message of [
		"Rate limit exceeded, too many requests",
		"429 Too Many Requests",
		"quota exhausted",
		"invalid api key",
		"",
		"context_length_exceeded: already prefixed",
	]) {
		assert.equal(normalizeOverflowError(message), null, message);
	}
});

test("message_end hook rewrites only this provider's overflow errors", () => {
	const fake = loadExtension();
	const hook = fake.handlers.get("message_end")![0];
	const base = { role: "assistant", stopReason: "error", provider: PROVIDER_ID, content: [], usage: {} };

	const rewritten = hook(
		{ message: { ...base, errorMessage: "Total tokens of image and text exceed max message tokens" } },
		{ model: { provider: PROVIDER_ID } },
	) as { message: { errorMessage: string; usage: unknown } } | undefined;
	assert.ok(rewritten?.message.errorMessage.startsWith("context_length_exceeded: "));
	assert.deepEqual(rewritten!.message.usage, {}, "other fields preserved");

	// idempotent
	assert.equal(hook({ message: { ...base, errorMessage: rewritten!.message.errorMessage } }, {}), undefined);
	// foreign provider untouched
	assert.equal(
		hook(
			{ message: { ...base, provider: "openai", errorMessage: "Range of input length should be [1, 5]" } },
			{ model: { provider: "openai" } },
		),
		undefined,
	);
	// ctx.model fallback detection
	assert.ok(
		hook(
			{ message: { role: "assistant", stopReason: "error", content: [], errorMessage: "OutofContextError" } },
			{ model: { provider: PROVIDER_ID } },
		),
	);
	// non-error / non-assistant ignored
	assert.equal(hook({ message: { ...base, stopReason: "stop", errorMessage: "OutofContextError" } }, {}), undefined);
	assert.equal(hook({ message: { role: "user", content: [] } }, {}), undefined);
});

// ---------------------------------------------------------------------------
// dynamic catalog merge
// ---------------------------------------------------------------------------

const RAW_LISTING = [
	{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", credit: 0.4 },
	{ id: "qwen3.8-flash", name: "Qwen3.8-Flash", credit: 0.21 },
	{ id: "glm-9", name: "GLM 9", credit: 3.3 },
	{ id: "auto", name: "Smart routing", credit: 1 },
	{ id: "kimi-k3" },
];

test("mergeGatewayCatalog refreshes names/credits and keeps verified caps", () => {
	const merged = mergeGatewayCatalog(RAW_LISTING);
	assert.equal(merged.length, 4, "auto entry skipped");
	const flash = merged.find((m) => m.id === "deepseek-v4-flash")!;
	assert.deepEqual(flash.cost, { input: 0.4, output: 0.4, cacheRead: 0, cacheWrite: 0 });
	assert.equal(flash.maxTokens, 393_216, "verified cap preserved");
	assert.equal(flash.contextWindow, 1_000_000);
	const kimi = merged.find((m) => m.id === "kimi-k3")!;
	assert.equal(kimi.name, "Kimi K3", "static name kept when listing has none");
	assert.equal(kimi.cost.input, 4.51, "static credit kept when listing has none");
});

test("mergeGatewayCatalog auto-registers unknown models conservatively", () => {
	const merged = mergeGatewayCatalog(RAW_LISTING);
	const glm9 = merged.find((m) => m.id === "glm-9")!;
	assert.equal(glm9.api, "openai-completions");
	assert.deepEqual(glm9.input, ["text"]);
	assert.equal(glm9.reasoning, true);
	assert.equal(glm9.cost.input, 3.3);
	assert.equal(glm9.contextWindow, 128_000);
	assert.deepEqual(Object.values(glm9.thinkingLevelMap ?? {}), [null, null, null, null, null, null, null]);
});

test("mergeGatewayCatalog falls back to static catalog on junk listings", () => {
	assert.equal(mergeGatewayCatalog([]).length, CATALOG.length);
	assert.equal(mergeGatewayCatalog([{ id: "auto" }]).length, CATALOG.length);
	assert.equal(mergeGatewayCatalog([{} as never, { id: 42 } as never]).length, CATALOG.length);
});

test("unknownModelConfig defaults", () => {
	const model = unknownModelConfig("new-model", "  New Model  ", 2);
	assert.equal(model.id, "new-model");
	assert.equal(model.name, "New Model");
	assert.equal(model.cost.input, 2);
	const nameless = unknownModelConfig("x");
	assert.equal(nameless.name, "x");
	assert.equal(nameless.cost.input, 0);
});

// ---------------------------------------------------------------------------
// refreshGatewayModels
// ---------------------------------------------------------------------------

function refreshContext(overrides: Partial<GatewayRefreshContext> = {}): {
	ctx: GatewayRefreshContext;
	published: { persist?: unknown; update?: () => void }[];
} {
	const published: { persist?: unknown; update?: () => void }[] = [];
	const ctx: GatewayRefreshContext = {
		credential: { type: "api_key", key: "test-key" },
		stored: undefined,
		publish: async (publication) => {
			published.push(publication);
			return true;
		},
		allowNetwork: true,
		signal: new AbortController().signal,
		...overrides,
	};
	return { ctx, published };
}

function fetchStub(response: { ok: boolean; status?: number; body?: unknown } | Error) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const impl = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		if (response instanceof Error) throw response;
		return {
			ok: response.ok,
			status: response.status ?? (response.ok ? 200 : 500),
			json: async () => response.body,
		} as unknown as Response;
	}) as typeof fetch;
	return { impl, calls };
}

test("refresh: offline restores nothing new and never fetches", async () => {
	const { impl, calls } = fetchStub({ ok: true, body: { data: RAW_LISTING } });
	const { ctx } = refreshContext({ allowNetwork: false });
	const models = await refreshGatewayModels(ctx, {}, impl);
	assert.equal(models.length, CATALOG.length, "static catalog");
	assert.equal(calls.length, 0);
});

test("refresh: offline uses persisted catalog when present", async () => {
	const stored = {
		models: [{ ...CATALOG[0]!, provider: PROVIDER_ID, cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } }],
		checkedAt: Date.now(),
	};
	const { impl, calls } = fetchStub({ ok: true, body: { data: RAW_LISTING } });
	const { ctx } = refreshContext({ allowNetwork: false, stored });
	const models = await refreshGatewayModels(ctx, {}, impl);
	assert.equal(models.length, 1);
	assert.equal(models[0]!.cost.input, 9);
	assert.equal(calls.length, 0);
});

test("refresh: fresh cache short-circuits the network", async () => {
	const { impl, calls } = fetchStub({ ok: true, body: { data: RAW_LISTING } });
	const { ctx } = refreshContext({ stored: { models: [], checkedAt: Date.now() } });
	const models = await refreshGatewayModels(ctx, {}, impl);
	assert.equal(models.length, CATALOG.length, "empty stored list falls back to static");
	assert.equal(calls.length, 0);
});

test("refresh: fetches, merges, persists and sends bearer auth", async () => {
	const { impl, calls } = fetchStub({ ok: true, body: { data: RAW_LISTING } });
	const { ctx, published } = refreshContext();
	const models = await refreshGatewayModels(ctx, { VOLCEAPI_BASE_URL: "https://gw.example/v1/" }, impl);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, "https://gw.example/v1/models");
	assert.deepEqual((calls[0]!.init?.headers as Record<string, string>).Authorization, "Bearer test-key");
	assert.equal(models.length, 4);
	assert.equal(models.find((m) => m.id === "deepseek-v4-flash")!.cost.input, 0.4);
	assert.equal(published.length, 1);
	const persist = published[0]!.persist as { models: { provider: string; baseUrl: string }[]; checkedAt: number };
	assert.equal(persist.models.length, 4);
	assert.equal(persist.models[0]!.provider, PROVIDER_ID);
	assert.equal(persist.models[0]!.baseUrl, "https://gw.example/v1");
	assert.ok(Date.now() - persist.checkedAt < 5_000);
});

test("refresh: stale cache forces a fetch", async () => {
	const { impl, calls } = fetchStub({ ok: true, body: { data: RAW_LISTING } });
	const stored = { models: [{ ...CATALOG[0]!, provider: PROVIDER_ID }], checkedAt: Date.now() - 13 * 60 * 60 * 1000 };
	const { ctx } = refreshContext({ stored });
	const models = await refreshGatewayModels(ctx, {}, impl);
	assert.equal(calls.length, 1);
	assert.equal(models.length, 4);
});

test("refresh: network failures degrade to cached/static list", async () => {
	for (const stub of [
		fetchStub(new Error("network down")),
		fetchStub({ ok: false, status: 502 }),
		fetchStub({ ok: true, body: { data: [] } }),
		fetchStub({ ok: true, body: { nope: true } }),
	]) {
		const { ctx } = refreshContext();
		const models = await refreshGatewayModels(ctx, {}, stub.impl);
		assert.equal(models.length, CATALOG.length);
	}
});

test("refresh: without an api-key credential nothing is fetched", async () => {
	const { impl, calls } = fetchStub({ ok: true, body: { data: RAW_LISTING } });
	const { ctx } = refreshContext({ credential: { type: "oauth" } });
	const models = await refreshGatewayModels(ctx, {}, impl);
	assert.equal(calls.length, 0);
	assert.equal(models.length, CATALOG.length);
});
