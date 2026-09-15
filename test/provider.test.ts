/**
 * Offline tests for the Volcengine API Gateway provider extension.
 * Run with: npm test  (tsx --test)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extension, {
	CATALOG,
	DEFAULT_BASE_URL,
	PROVIDER_ID,
	STRIP_REASONING_SUMMARY,
	buildModels,
	createVolcengineGatewayProvider,
	fetchGatewayModels,
	mergeGatewayCatalog,
	normalizeOverflowError,
	resolveBaseUrl,
	rewriteProviderPayload,
	unknownModelConfig,
	validateGatewayKey,
	type GatewayModelEntry,
} from "../index.ts";
import { loadSettings } from "../settings.ts";

// ---------------------------------------------------------------------------
// fake pi harness
// ---------------------------------------------------------------------------

type AnyProvider = Record<string, any>;

interface FakePi {
	pi: {
		registerProvider: (nameOrProvider: unknown, config?: unknown) => void;
		on: (event: string, handler: (...args: never[]) => unknown) => void;
		registerCommand: (name: string, options: unknown) => void;
	};
	providers: Map<string, AnyProvider>;
	handlers: Map<string, ((...args: unknown[]) => unknown)[]>;
	commands: Map<string, unknown>;
}

function createFakePi(): FakePi {
	const providers = new Map<string, AnyProvider>();
	const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
	const commands = new Map<string, unknown>();
	return {
		pi: {
			registerProvider(nameOrProvider: unknown, config?: unknown) {
				if (typeof nameOrProvider === "string") providers.set(nameOrProvider, config as AnyProvider);
				else providers.set((nameOrProvider as AnyProvider).id, nameOrProvider as AnyProvider);
			},
			on(event: string, handler: (...args: never[]) => unknown) {
				const list = handlers.get(event) ?? [];
				list.push(handler as (...args: unknown[]) => unknown);
				handlers.set(event, list);
			},
			registerCommand(name: string, options: unknown) {
				commands.set(name, options);
			},
		},
		providers,
		handlers,
		commands,
	};
}

const testDir = mkdtempSync(join(tmpdir(), "volc-provider-test-"));
let settingsCounter = 0;
function isolatedSettingsFile(): string {
	return join(testDir, `settings-${settingsCounter++}.json`);
}

function loadExtension(): FakePi {
	const fake = createFakePi();
	(extension as any)(fake.pi, { settingsFile: isolatedSettingsFile() });
	return fake;
}

// ---------------------------------------------------------------------------
// fetch / interaction stubs
// ---------------------------------------------------------------------------

type StubResponse = { ok?: boolean; status: number; body?: unknown } | Error;

function fetchStub(responses: StubResponse[] | StubResponse) {
	const queue = Array.isArray(responses) ? [...responses] : undefined;
	const single = Array.isArray(responses) ? undefined : responses;
	const calls: { url: string; init?: RequestInit }[] = [];
	const impl = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		const next = queue ? queue.shift() : single;
		if (next instanceof Error) throw next;
		if (!next) throw new Error("fetch stub exhausted");
		return {
			ok: next.ok ?? (next.status >= 200 && next.status < 300),
			status: next.status,
			json: async () => next.body,
		} as unknown as Response;
	}) as typeof fetch;
	return { impl, calls };
}

function fakeAuthContext(env: Record<string, string> = {}) {
	return {
		env: async (name: string) => env[name],
		fileExists: async () => false,
	};
}

function fakeInteraction(promptResults: (string | Error)[]) {
	const prompts: { type: string; message: string }[] = [];
	const notices: { type: string; message: string }[] = [];
	const queue = [...promptResults];
	return {
		prompts,
		notices,
		interaction: {
			signal: new AbortController().signal,
			async prompt(prompt: { type: string; message: string }) {
				prompts.push(prompt);
				const next = queue.shift();
				if (next instanceof Error) throw next;
				if (next === undefined) throw new Error("prompt queue exhausted");
				return next;
			},
			notify(event: { type: string; message: string }) {
				notices.push(event);
			},
		},
	};
}

const BASE = "https://gw.test/v1";

// ---------------------------------------------------------------------------
// registration shape (provider object form)
// ---------------------------------------------------------------------------

test("registers one native provider with both API surfaces", () => {
	const fake = loadExtension();
	assert.equal(fake.providers.size, 1);
	const provider = fake.providers.get(PROVIDER_ID)!;
	assert.ok(provider, "provider registered under volcengine-gateway");
	assert.equal(provider.name, "Volcengine API Gateway");
	assert.equal(provider.baseUrl, DEFAULT_BASE_URL);
	assert.equal(typeof provider.auth?.apiKey?.login, "function");
	assert.equal(typeof provider.auth?.apiKey?.check, "function");
	assert.equal(typeof provider.auth?.apiKey?.resolve, "function");
	assert.equal(typeof provider.refreshModels, "function");
	assert.equal(typeof provider.stream, "function");
	assert.equal(typeof provider.streamSimple, "function");

	const models = provider.getModels();
	assert.equal(models.length, CATALOG.length);
	for (const model of models) {
		assert.equal(model.provider, PROVIDER_ID);
		assert.equal(model.baseUrl, DEFAULT_BASE_URL);
		assert.ok(model.api === "openai-responses" || model.api === "openai-completions");
	}
});

test("registers payload + message_end hooks", () => {
	const fake = loadExtension();
	assert.equal(fake.handlers.get("before_provider_request")?.length, 1);
	assert.equal(fake.handlers.get("message_end")?.length, 1);
});

test("resolveBaseUrl honors env override and strips trailing slashes", () => {
	assert.equal(resolveBaseUrl({} as NodeJS.ProcessEnv), DEFAULT_BASE_URL);
	assert.equal(resolveBaseUrl({ VOLCEAPI_BASE_URL: "https://example.com/v1//" } as NodeJS.ProcessEnv), "https://example.com/v1");
});

test("createVolcengineGatewayProvider honors baseUrl option", () => {
	const provider = createVolcengineGatewayProvider({ baseUrl: BASE });
	assert.equal(provider.baseUrl, BASE);
	assert.ok(provider.getModels().every((m) => m.baseUrl === BASE && m.provider === PROVIDER_ID));
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
	assert.equal(CATALOG.filter((m) => m.api === "openai-responses").length, 10);
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

	for (const id of ["glm-5.3", "glm-5.3-flash", "zhipu/glm-5.3"]) {
		assert.equal(map(id).off, null, `${id}: thinking cannot be disabled`);
		assert.equal(map(id).medium, null, `${id}: medium rejected by gateway`);
		assert.equal(map(id).low, "low");
		assert.equal(map(id).high, "high");
		assert.equal(map(id).max, "max");
	}
	for (const id of ["deepseek-v4-flash", "deepseek-v4-pro", "doubao-seed-2.1-pro", "glm-5.2", "qwen3.8-flash"]) {
		assert.equal(map(id).off, "none", `${id}: off maps to effort none`);
	}
	const kimi = map("kimi-k2.7-code");
	assert.equal(kimi.off, null);
	assert.equal(kimi.high, "high");
	assert.equal(kimi.low, null);

	assert.deepEqual(
		[...STRIP_REASONING_SUMMARY].sort(),
		["deepseek-v4-flash", "doubao-seed-2.1-pro", "glm-5.2"].sort(),
	);

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
		const payload = { model, input: [], store: false, reasoning: { effort: "high", summary: "auto" } };
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

	assert.equal(hook({ message: { ...base, errorMessage: rewritten!.message.errorMessage } }, {}), undefined);
	assert.equal(
		hook(
			{ message: { ...base, provider: "openai", errorMessage: "Range of input length should be [1, 5]" } },
			{ model: { provider: "openai" } },
		),
		undefined,
	);
	assert.ok(
		hook(
			{ message: { role: "assistant", stopReason: "error", content: [], errorMessage: "OutofContextError" } },
			{ model: { provider: PROVIDER_ID } },
		),
	);
	assert.equal(hook({ message: { ...base, stopReason: "stop", errorMessage: "OutofContextError" } }, {}), undefined);
	assert.equal(hook({ message: { role: "user", content: [] } }, {}), undefined);
});

// ---------------------------------------------------------------------------
// dynamic catalog merge
// ---------------------------------------------------------------------------

const RAW_LISTING: GatewayModelEntry[] = [
	{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", credit: 0.4 },
	{ id: "qwen3.8-flash", name: "Qwen3.8-Flash", credit: 0.21 },
	{ id: "glm-9", name: "GLM 9", credit: 3.3 },
	{ id: "auto", name: "Smart routing", credit: 1 },
	{ id: "kimi-k3" },
];

test("mergeGatewayCatalog refreshes names/credits and keeps verified caps", () => {
	const merged = mergeGatewayCatalog(RAW_LISTING, BASE);
	assert.equal(merged.length, 4, "auto entry skipped");
	const flash = merged.find((m) => m.id === "deepseek-v4-flash")!;
	assert.deepEqual(flash.cost, { input: 0.4, output: 0.4, cacheRead: 0.4, cacheWrite: 0 });
	assert.equal(flash.maxTokens, 393_216, "verified cap preserved");
	assert.equal(flash.contextWindow, 1_000_000);
	assert.equal(flash.provider, PROVIDER_ID);
	assert.equal(flash.baseUrl, BASE);
	const kimi = merged.find((m) => m.id === "kimi-k3")!;
	assert.equal(kimi.name, "Kimi K3", "static name kept when listing has none");
	assert.equal(kimi.cost.input, 4.51, "static credit kept when listing has none");
});

test("mergeGatewayCatalog auto-registers unknown models conservatively", () => {
	const merged = mergeGatewayCatalog(RAW_LISTING, BASE);
	const glm9 = merged.find((m) => m.id === "glm-9")!;
	assert.equal(glm9.api, "openai-completions");
	assert.deepEqual(glm9.input, ["text"]);
	assert.equal(glm9.reasoning, true);
	assert.equal(glm9.cost.input, 3.3);
	assert.equal(glm9.contextWindow, 128_000);
	assert.equal(glm9.baseUrl, BASE);
	assert.deepEqual(Object.values(glm9.thinkingLevelMap ?? {}), [null, null, null, null, null, null, null]);
});

test("mergeGatewayCatalog falls back to static catalog on junk listings", () => {
	assert.equal(mergeGatewayCatalog([], BASE).length, CATALOG.length);
	assert.equal(mergeGatewayCatalog([{ id: "auto" }], BASE).length, CATALOG.length);
	assert.equal(mergeGatewayCatalog([{} as never, { id: 42 } as never], BASE).length, CATALOG.length);
});

test("unknownModelConfig defaults", () => {
	const model = unknownModelConfig("new-model", BASE, "  New Model  ", 2);
	assert.equal(model.id, "new-model");
	assert.equal(model.name, "New Model");
	assert.deepEqual(model.cost, { input: 2, output: 2, cacheRead: 2, cacheWrite: 0 });
	assert.equal(model.provider, PROVIDER_ID);
	assert.equal((model.compat as Record<string, unknown>).supportsLongCacheRetention, true);
	const nameless = unknownModelConfig("x", BASE);
	assert.equal(nameless.name, "x");
	assert.equal(nameless.cost.input, 0);
});

test("retention matrix: only routes verified to accept prompt_cache_retention", () => {
	const retention = new Map(
		CATALOG.map((m) => [m.id, (m.compat as Record<string, unknown>).supportsLongCacheRetention]),
	);
	// rejected with "json: unknown field" (probe 2026-09-15)
	for (const id of ["deepseek-v4-flash", "doubao-seed-2.1-pro", "glm-5.2"]) {
		assert.equal(retention.get(id), false, id);
	}
	// accepted with 200 (probe 2026-09-15)
	for (const id of [
		"deepseek-v4-pro",
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
		assert.equal(retention.get(id), true, id);
	}
});

// ---------------------------------------------------------------------------
// fetchGatewayModels + provider.refreshModels (pi-ai wrapper integration)
// ---------------------------------------------------------------------------

function refreshContext(overrides: Record<string, unknown> = {}) {
	const published: any[] = [];
	const ctx = {
		credential: { type: "api_key", key: "test-key" },
		stored: undefined,
		publish: async (publication: any) => {
			published.push(publication);
			publication.update?.();
			return true;
		},
		allowNetwork: true,
		force: true,
		signal: new AbortController().signal,
		...overrides,
	} as any;
	return { ctx, published };
}

test("fetchGatewayModels: fetches, merges and sends bearer auth", async () => {
	const { impl, calls } = fetchStub({ status: 200, body: { data: RAW_LISTING } });
	const { ctx } = refreshContext();
	const models = await fetchGatewayModels(ctx, "https://gw.test/v1", impl);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, "https://gw.test/v1/models");
	assert.deepEqual((calls[0]!.init?.headers as Record<string, string>).Authorization, "Bearer test-key");
	assert.equal(models.length, 4);
	assert.equal(models.find((m) => m.id === "deepseek-v4-flash")!.cost.input, 0.4);
});

test("fetchGatewayModels: degrades to static catalog on any failure", async () => {
	for (const stub of [
		fetchStub(new Error("network down")),
		fetchStub({ status: 502 }),
		fetchStub({ status: 200, body: { data: [] } }),
		fetchStub({ status: 200, body: { nope: true } }),
	]) {
		const { ctx } = refreshContext();
		const models = await fetchGatewayModels(ctx, BASE, stub.impl);
		assert.equal(models.length, CATALOG.length);
		assert.ok(models.every((m) => m.provider === PROVIDER_ID));
	}
	const { ctx } = refreshContext({ credential: { type: "oauth" } });
	const { impl, calls } = fetchStub({ status: 200, body: { data: RAW_LISTING } });
	assert.equal((await fetchGatewayModels(ctx, BASE, impl)).length, CATALOG.length);
	assert.equal(calls.length, 0, "no key -> no fetch");
});

test("provider.refreshModels: offline start restores persisted overlay", async () => {
	const { impl, calls } = fetchStub({ status: 200, body: { data: RAW_LISTING } });
	const provider = createVolcengineGatewayProvider({ baseUrl: BASE, fetchImpl: impl });
	const storedFlash = { ...buildModels(BASE)[0]!, cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } };
	const { ctx } = refreshContext({ allowNetwork: false, stored: { models: [storedFlash], checkedAt: Date.now() } });
	await (provider as any).refreshModels(ctx);
	assert.equal(calls.length, 0, "offline never fetches");
	const models = provider.getModels();
	assert.equal(models.length, CATALOG.length);
	assert.equal(models.find((m) => m.id === storedFlash.id)!.cost.input, 9, "stored overlay applied");
});

test("provider.refreshModels: network run persists merged catalog", async () => {
	const { impl, calls } = fetchStub({ status: 200, body: { data: RAW_LISTING } });
	const provider = createVolcengineGatewayProvider({ baseUrl: BASE, fetchImpl: impl });
	const { ctx, published } = refreshContext();
	await (provider as any).refreshModels(ctx);
	assert.equal(calls.length, 1);
	const persisted = published.map((p) => p.persist).filter(Boolean);
	assert.equal(persisted.length, 1);
	assert.equal(persisted[0].models.length, 4);
	assert.equal(typeof persisted[0].checkedAt, "number");
	const models = provider.getModels();
	assert.ok(models.find((m) => m.id === "glm-9"), "new gateway model added");
	assert.equal(models.find((m) => m.id === "deepseek-v4-flash")!.cost.input, 0.4, "credits refreshed");
});

// ---------------------------------------------------------------------------
// prompt_cache_retention wiring (payload level, via real pi-ai builders)
// ---------------------------------------------------------------------------

type CapturedPayload = Record<string, any> | undefined;

async function capturePayload(provider: AnyProvider, modelId: string, cacheRetention: "long" | "short" | "none") {
	const model = provider.getModels().find((m: AnyProvider) => m.id === modelId)!;
	const context = {
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: new Date().toISOString() }],
		systemPrompt: "",
		tools: [],
	};
	let payload: CapturedPayload;
	try {
		await provider
			.stream(model, context as never, {
				apiKey: "test-key",
				cacheRetention,
				sessionId: "sess-retention-test",
				onPayload: async (p: Record<string, any>) => {
					payload = p;
					throw new Error("capture-stop");
				},
			})
			.result();
	} catch {
		// capture-stop terminates the stream; payload already recorded
	}
	return payload;
}

test("PI_CACHE_RETENTION=long sends prompt_cache_retention:24h only on verified routes", async () => {
	const provider = createVolcengineGatewayProvider({ baseUrl: BASE });

	// responses: accepted models get the field + cache key
	for (const id of ["qwen3.8-flash", "glm-5.3", "deepseek-v4-pro"]) {
		const payload = await capturePayload(provider, id, "long");
		assert.equal(payload?.prompt_cache_retention, "24h", `${id}: retention sent`);
		assert.equal(payload?.prompt_cache_key, "sess-retention-test", `${id}: cache key sent`);
	}
	// responses: strict models must never see the field (gateway 400s)
	for (const id of ["deepseek-v4-flash", "doubao-seed-2.1-pro", "glm-5.2"]) {
		const payload = await capturePayload(provider, id, "long");
		assert.equal(payload?.prompt_cache_retention, undefined, `${id}: retention suppressed`);
		assert.equal(payload?.prompt_cache_key, "sess-retention-test", `${id}: cache key still sent`);
	}
	// chat: all routes accepted retention
	for (const id of ["kimi-k2.7-code", "MiniMax-M3", "zhipu/glm-5.3"]) {
		const payload = await capturePayload(provider, id, "long");
		assert.equal(payload?.prompt_cache_retention, "24h", `${id}: retention sent`);
		assert.equal(payload?.prompt_cache_key, "sess-retention-test", `${id}: cache key sent`);
	}
});

test("default (short) retention sends no retention field anywhere", async () => {
	const provider = createVolcengineGatewayProvider({ baseUrl: BASE });
	for (const id of ["qwen3.8-flash", "kimi-k2.7-code"]) {
		const payload = await capturePayload(provider, id, "short");
		assert.equal(payload?.prompt_cache_retention, undefined, `${id}: no retention in short mode`);
	}
	// responses still gets the affinity key in short mode; chat does not
	// (pi-ai sends chat prompt_cache_key only for api.openai.com or long retention)
	const responses = await capturePayload(provider, "qwen3.8-flash", "short");
	assert.equal(responses?.prompt_cache_key, "sess-retention-test");
	const chat = await capturePayload(provider, "kimi-k2.7-code", "short");
	assert.equal(chat?.prompt_cache_key, undefined);
});

// ---------------------------------------------------------------------------
// key validation + login flow
// ---------------------------------------------------------------------------

test("validateGatewayKey: 400 means the key authenticated (zero inference)", async () => {
	const { impl, calls } = fetchStub({ status: 400, body: "AI request body should have string model field." });
	const result = await validateGatewayKey("secret-key-value", { baseUrl: BASE, fetchImpl: impl });
	assert.deepEqual(result, { status: "valid" });
	assert.equal(calls[0]!.url, `${BASE}/responses`);
	assert.equal(calls[0]!.init?.method, "POST");
	assert.equal(calls[0]!.init?.body, "{}");
	assert.deepEqual((calls[0]!.init?.headers as Record<string, string>).Authorization, "Bearer secret-key-value");
	assert.doesNotMatch(JSON.stringify(result), /secret-key-value/);
});

test("validateGatewayKey: status matrix", async () => {
	const cases: [StubResponse, string][] = [
		[{ status: 200 }, "valid"],
		[{ status: 401 }, "invalid"],
		[{ status: 403 }, "invalid"],
		[{ status: 500 }, "unavailable"],
		[new Error("network unavailable"), "unavailable"],
	];
	for (const [stub, expected] of cases) {
		const { impl } = fetchStub(stub);
		const result = await validateGatewayKey("k", { baseUrl: BASE, fetchImpl: impl });
		assert.equal(result.status, expected, JSON.stringify(stub));
		assert.doesNotMatch(JSON.stringify(result), /"k"/, "key never appears in results");
	}
	const { impl } = fetchStub({ status: 503 });
	assert.match((await validateGatewayKey("k", { baseUrl: BASE, fetchImpl: impl })).reason ?? "", /HTTP 503/);
});

test("login: validates the key and stores it", async () => {
	const { impl } = fetchStub({ status: 400 });
	const provider = createVolcengineGatewayProvider({ baseUrl: BASE, fetchImpl: impl });
	const { interaction, prompts, notices } = fakeInteraction(["  good-key  "]);
	const credential = await provider.auth.apiKey!.login!(interaction as any);
	assert.deepEqual(credential, { type: "api_key", key: "good-key" });
	assert.equal(prompts.length, 1);
	assert.equal(prompts[0]!.type, "secret");
	assert.ok(notices.some((n) => n.message.includes("validated")), "success notification");
});

test("login: re-prompts after an invalid key", async () => {
	const { impl, calls } = fetchStub([{ status: 401 }, { status: 400 }]);
	const provider = createVolcengineGatewayProvider({ baseUrl: BASE, fetchImpl: impl });
	const { interaction, prompts, notices } = fakeInteraction(["bad-key", "rekey", "good-key"]);
	const credential = await provider.auth.apiKey!.login!(interaction as any);
	assert.deepEqual(credential, { type: "api_key", key: "good-key" });
	assert.equal(prompts.filter((p) => p.type === "secret").length, 2);
	assert.equal(calls.length, 2);
	assert.ok(notices.some((n) => n.message.includes("rejected")), "rejection notification");
});

// ── login-time endpoint switching (variant B) ──────────────────────────

type LoginProvider = ReturnType<typeof createVolcengineGatewayProvider>;

function loginProvider(fetchImpl: typeof fetch, settingsFile?: string): LoginProvider {
	return createVolcengineGatewayProvider({ baseUrl: BASE, fetchImpl, settingsFile });
}

test("login: 401 → change endpoint → probe ok → persisted, rebound, key re-validated", async () => {
	const settingsFile = isolatedSettingsFile();
	const { impl, calls } = fetchStub([
		{ status: 401 }, // validate key against the default URL
		{ status: 200, body: { data: [{ id: "m1" }] } }, // probe the candidate with the key
		{ status: 400 }, // re-validate the key against the new URL
	]);
	const provider = loginProvider(impl, settingsFile);
	const { interaction, prompts, notices } = fakeInteraction(["my-key", "reurl", "https://gw2.example/v1/"]);
	const credential = await provider.auth.apiKey!.login!(interaction as any);
	assert.deepEqual(credential, { type: "api_key", key: "my-key" });
	assert.deepEqual(prompts.map((p) => p.type), ["secret", "select", "text"]);
	assert.equal(calls[1]!.url, "https://gw2.example/v1/models", "candidate normalized before probing");
	assert.equal(calls[2]!.url, "https://gw2.example/v1/responses", "key re-validated against the new URL");
	assert.equal(loadSettings(settingsFile).baseUrl, "https://gw2.example/v1", "endpoint persisted");
	assert.equal((provider as any).baseUrl, "https://gw2.example/v1", "provider rebound in-place");
	assert.ok(provider.getModels().every((m) => m.baseUrl === "https://gw2.example/v1"), "all models rebound");
	assert.ok(notices.some((n) => n.message.includes("Endpoint verified")));
});

test("login: empty custom URL keeps the current endpoint", async () => {
	const settingsFile = isolatedSettingsFile();
	const { impl, calls } = fetchStub([{ status: 401 }, { status: 400 }]);
	const provider = loginProvider(impl, settingsFile);
	const { interaction, prompts } = fakeInteraction(["k1", "reurl", "  ", "k2"]);
	const credential = await provider.auth.apiKey!.login!(interaction as any);
	assert.equal(credential.key, "k2");
	assert.deepEqual(prompts.map((p) => p.type), ["secret", "select", "text", "secret"]);
	assert.deepEqual(calls.map((c) => c.url), [`${BASE}/responses`, `${BASE}/responses`], "stayed on the default URL");
	assert.equal(loadSettings(settingsFile).baseUrl, undefined, "nothing persisted");
	assert.equal((provider as any).baseUrl, BASE);
});

test("login: invalid URL re-prompts; unverified candidate → keep escapes back to key", async () => {
	const settingsFile = isolatedSettingsFile();
	const { impl, calls } = fetchStub([
		{ status: 401 }, // default rejects k1
		new Error("connect ENETUNREACH"), // probe of gw3 fails
		{ status: 400 }, // default accepts k2
	]);
	const provider = loginProvider(impl, settingsFile);
	const { interaction, prompts, notices } = fakeInteraction([
		"k1",
		"reurl",
		"ftp://x", // invalid → re-prompt
		"https://gw3.example/v1",
		"keep", // probe failed → keep current
		"k2",
	]);
	const credential = await provider.auth.apiKey!.login!(interaction as any);
	assert.equal(credential.key, "k2");
	assert.deepEqual(prompts.map((p) => p.type), ["secret", "select", "text", "text", "select", "secret"]);
	assert.ok(notices.some((n) => n.message.includes("not a valid http(s) URL")));
	assert.ok(notices.some((n) => n.message.includes("did not respond")));
	assert.equal(loadSettings(settingsFile).baseUrl, undefined, "nothing persisted after keep");
	assert.deepEqual(calls.map((c) => c.url), [`${BASE}/responses`, "https://gw3.example/v1/models", `${BASE}/responses`]);
});

test("login: candidate rejects the key too → try another URL → success", async () => {
	const settingsFile = isolatedSettingsFile();
	const { impl } = fetchStub([
		{ status: 401 }, // default rejects
		{ status: 401 }, // gw4 probe with key → auth (alive, wrong key there)
		{ status: 200, body: { data: [] } }, // gw5 probe → ok
		{ status: 400 }, // validate against gw5
	]);
	const provider = loginProvider(impl, settingsFile);
	const { interaction, prompts, notices } = fakeInteraction([
		"k1",
		"reurl",
		"https://gw4.example/v1",
		"another", // gw4 rejected the key → different URL
		"https://gw5.example/v1",
	]);
	const credential = await provider.auth.apiKey!.login!(interaction as any);
	assert.equal(credential.key, "k1");
	assert.deepEqual(prompts.map((p) => p.type), ["secret", "select", "text", "select", "text"]);
	assert.ok(notices.some((n) => n.message.includes("REJECTED the current key")));
	assert.equal(loadSettings(settingsFile).baseUrl, "https://gw5.example/v1");
	assert.equal((provider as any).baseUrl, "https://gw5.example/v1");
});

test("login: probe auth + use anyway → saved, then key loop continues against new URL", async () => {
	const settingsFile = isolatedSettingsFile();
	const { impl, calls } = fetchStub([
		{ status: 401 }, // default rejects k1
		{ status: 401 }, // gw7 probe with k1 → auth
		{ status: 401 }, // k1 also rejected by gw7 → invalid select again
		{ status: 400 }, // k2 valid on gw7
	]);
	const provider = loginProvider(impl, settingsFile);
	const { interaction, prompts } = fakeInteraction(["k1", "reurl", "https://gw7.example/v1", "use", "rekey", "k2"]);
	const credential = await provider.auth.apiKey!.login!(interaction as any);
	assert.equal(credential.key, "k2");
	assert.deepEqual(prompts.map((p) => p.type), ["secret", "select", "text", "select", "select", "secret"]);
	assert.equal(loadSettings(settingsFile).baseUrl, "https://gw7.example/v1", "saved despite unverified probe");
	assert.equal(calls[3]!.url, "https://gw7.example/v1/responses", "rekey validated against the new URL");
});

test("login: unreachable default also offers the endpoint change", async () => {
	const settingsFile = isolatedSettingsFile();
	const { impl, calls } = fetchStub([
		new Error("connect ECONNREFUSED"), // default unreachable
		{ status: 200, body: { data: [{ id: "m" }] } }, // gw6 probe ok
		{ status: 400 }, // validate against gw6
	]);
	const provider = loginProvider(impl, settingsFile);
	const { interaction, prompts } = fakeInteraction(["k1", "reurl", "https://gw6.example/v1"]);
	const credential = await provider.auth.apiKey!.login!(interaction as any);
	assert.equal(credential.key, "k1");
	assert.deepEqual(prompts.map((p) => p.type), ["secret", "select", "text"]);
	assert.equal(loadSettings(settingsFile).baseUrl, "https://gw6.example/v1");
	assert.equal(calls[2]!.url, "https://gw6.example/v1/responses");
});

test("login: unreachable gateway offers retry and save-anyway", async () => {
	const { impl } = fetchStub([new Error("connect ECONNREFUSED"), { status: 400 }]);
	const provider = createVolcengineGatewayProvider({ baseUrl: BASE, fetchImpl: impl });
	const { interaction, prompts } = fakeInteraction(["key-1", "retry"]);
	const credential = await provider.auth.apiKey!.login!(interaction as any);
	assert.deepEqual(credential, { type: "api_key", key: "key-1" });
	assert.deepEqual(prompts.map((p) => p.type), ["secret", "select"]);
});

test("login: save-without-validation escape hatch", async () => {
	const { impl } = fetchStub(new Error("connect ECONNREFUSED"));
	const provider = createVolcengineGatewayProvider({ baseUrl: BASE, fetchImpl: impl });
	const { interaction, prompts } = fakeInteraction(["key-2", "save"]);
	const credential = await provider.auth.apiKey!.login!(interaction as any);
	assert.deepEqual(credential, { type: "api_key", key: "key-2" });
	assert.deepEqual(prompts.map((p) => p.type), ["secret", "select"]);
});

test("login: empty input re-prompts without wasting a validation call", async () => {
	const { impl, calls } = fetchStub({ status: 400 });
	const provider = createVolcengineGatewayProvider({ baseUrl: BASE, fetchImpl: impl });
	const { interaction, prompts } = fakeInteraction(["   ", "key-3"]);
	const credential = await provider.auth.apiKey!.login!(interaction as any);
	assert.equal(credential.key, "key-3");
	assert.equal(prompts.filter((p) => p.type === "secret").length, 2);
	assert.equal(calls.length, 1);
});

test("auth check/resolve: stored credential wins over env", async () => {
	const provider = createVolcengineGatewayProvider({ baseUrl: BASE });
	const check = provider.auth.apiKey!.check!;
	const resolve = provider.auth.apiKey!.resolve!;
	const signal = new AbortController().signal;
	const ctx = fakeAuthContext({ VOLCEAPI_API_KEY: " env-key " });

	const stored = await check({ ctx, credential: { type: "api_key", key: "stored-key" }, signal });
	assert.deepEqual(stored, { type: "api_key", source: "stored credential (Pi auth.json)" });
	const fromEnv = await check({ ctx, signal });
	assert.deepEqual(fromEnv, { type: "api_key", source: "$VOLCEAPI_API_KEY" });
	assert.equal(await check({ ctx: fakeAuthContext({}), signal }), undefined);

	const resolvedStored = await resolve({ ctx, credential: { type: "api_key", key: "stored-key" }, signal });
	assert.equal(resolvedStored?.auth.apiKey, "stored-key");
	const resolvedEnv = await resolve({ ctx, signal });
	assert.equal(resolvedEnv?.auth.apiKey, "env-key", "env value trimmed");
	assert.equal(resolvedEnv?.source, "$VOLCEAPI_API_KEY");
	assert.equal(await resolve({ ctx: fakeAuthContext({}), signal }), undefined);
});
