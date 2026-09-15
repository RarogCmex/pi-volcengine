/**
 * Offline tests for the /volcengine settings command, settings store and
 * cache-retention payload injection.
 * Run with: npm test  (tsx --test)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extension, {
	NO_RETENTION_MODELS,
	PROVIDER_ID,
	RETENTION_MODELS,
	type VolcCtx,
} from "../index.ts";
import {
	applyCacheRetention,
	clampCacheKey,
	completeArgs,
	DEFAULT_SETTINGS,
	loadSettings,
	parseCacheArg,
	saveSettings,
	settingsPath,
	volcengineCommands,
	type VolcengineSettings,
} from "../settings.ts";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "volc-settings-test-"));
let tmpCounter = 0;
function tmpSettingsFile(content?: unknown): string {
	const file = join(tmp, `settings-${tmpCounter++}.json`);
	if (content !== undefined) writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
	return file;
}

type StubResponse = { status: number; body?: unknown } | Error;

function fetchStub(response: StubResponse) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const impl = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		if (response instanceof Error) throw response;
		return { ok: response.status < 300, status: response.status, json: async () => response.body } as unknown as Response;
	}) as typeof fetch;
	return { impl, calls };
}

interface FakePi {
	pi: Record<string, unknown>;
	providers: Map<string, unknown>;
	handlers: Map<string, ((...args: unknown[]) => unknown)[]>;
	commands: Map<string, { description?: string; getArgumentCompletions?: (prefix: string) => unknown; handler: (args: string, ctx: never) => Promise<void> }>;
}

function createFakePi(): FakePi {
	const providers = new Map<string, unknown>();
	const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
	const commands = new Map<string, any>();
	return {
		pi: {
			registerProvider(provider: any) {
				providers.set(provider.id, provider);
			},
			on(event: string, handler: (...args: never[]) => unknown) {
				const list = handlers.get(event) ?? [];
				list.push(handler as (...args: unknown[]) => unknown);
				handlers.set(event, list);
			},
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
		},
		providers,
		handlers,
		commands,
	};
}

function loadExtension(options: { settingsFile?: string; fetchImpl?: typeof fetch } = {}): FakePi {
	const fake = createFakePi();
	(extension as any)(fake.pi, options);
	return fake;
}

function fakeCtx(overrides: Record<string, unknown> = {}) {
	const notifications: { message: string; type?: string }[] = [];
	const statuses: { key: string; text: string | undefined }[] = [];
	const refreshCalls: unknown[] = [];
	const ctx: VolcCtx = {
		hasUI: false,
		ui: {
			notify(message: string, type?: "info" | "warning" | "error") {
				notifications.push({ message, type });
			},
			setStatus(key: string, text: string | undefined) {
				statuses.push({ key, text });
			},
		},
		model: undefined,
		signal: new AbortController().signal,
		modelRegistry: {
			getAll: () => [
				{ id: "qwen3.8-flash", provider: PROVIDER_ID },
				{ id: "gpt-5.5", provider: "openai" },
			],
			getProviderAuthStatus: () => ({ configured: true, source: "stored" as const }),
			getApiKeyForProvider: async () => "test-key",
			refresh: async (opts) => {
				refreshCalls.push(opts);
				return { aborted: false, errors: new Map<string, Error>() };
			},
		},
		sessionManager: { getSessionId: () => "sess-42" },
		...overrides,
	} as VolcCtx;
	return { ctx, notifications, statuses, refreshCalls };
}

// ---------------------------------------------------------------------------
// settings store
// ---------------------------------------------------------------------------

test("settingsPath defaults under ~/.pi/agent", () => {
	assert.equal(settingsPath("/base"), join("/base", "volcengine-gateway.json"));
	assert.match(settingsPath(), /\.pi\/agent\/volcengine-gateway\.json$/);
});

test("loadSettings degrades to defaults on missing/corrupt/foreign files", () => {
	assert.deepEqual(loadSettings(join(tmp, "does-not-exist.json")), DEFAULT_SETTINGS);
	assert.deepEqual(loadSettings(tmpSettingsFile("{not json")), DEFAULT_SETTINGS);
	assert.deepEqual(loadSettings(tmpSettingsFile({ version: 2, cacheRetention: "long" })), DEFAULT_SETTINGS);
	assert.deepEqual(loadSettings(tmpSettingsFile(null)), DEFAULT_SETTINGS);
	assert.deepEqual(loadSettings(tmpSettingsFile({ version: 1, cacheRetention: "garbage" })), {
		version: 1,
		cacheRetention: "short",
	});
});

test("saveSettings persists and round-trips", () => {
	const file = tmpSettingsFile();
	const saved = saveSettings({ cacheRetention: "long" }, file);
	assert.equal(saved.cacheRetention, "long");
	assert.equal(typeof saved.updatedAt, "string");
	assert.deepEqual(loadSettings(file), saved);
	const off = saveSettings({ cacheRetention: "short" }, file);
	assert.equal(loadSettings(file).cacheRetention, "short");
	assert.ok(off.updatedAt! >= saved.updatedAt!);
});

test("parseCacheArg matrix", () => {
	for (const arg of ["on", "ON", " long ", "24h", "enable", "true"]) assert.equal(parseCacheArg(arg), "long", arg);
	for (const arg of ["off", "Short", "default", "disable", "false"]) assert.equal(parseCacheArg(arg), "short", arg);
	assert.equal(parseCacheArg(""), "status");
	assert.equal(parseCacheArg(undefined), "status");
	assert.equal(parseCacheArg("status"), "status");
	assert.equal(parseCacheArg("bogus"), undefined);
});

// ---------------------------------------------------------------------------
// cache-retention payload injection
// ---------------------------------------------------------------------------

const SUPPORTED = new Set(["qwen3.8-flash", "MiniMax-M3"]);

test("applyCacheRetention: disabled or unsupported -> untouched", () => {
	const payload = { model: "qwen3.8-flash", input: [], store: false };
	assert.equal(applyCacheRetention(payload, { enabled: false, supportedModels: SUPPORTED, sessionId: "s" }), undefined);
	assert.equal(applyCacheRetention({ model: "glm-5.2", input: [], store: false }, { enabled: true, supportedModels: SUPPORTED }), undefined);
	assert.equal(applyCacheRetention(undefined, { enabled: true, supportedModels: SUPPORTED }), undefined);
	assert.equal(applyCacheRetention("x", { enabled: true, supportedModels: SUPPORTED }), undefined);
	assert.equal(applyCacheRetention({ input: [], store: false }, { enabled: true, supportedModels: SUPPORTED }), undefined);
	// neither responses nor chat shape
	assert.equal(applyCacheRetention({ model: "qwen3.8-flash" }, { enabled: true, supportedModels: SUPPORTED }), undefined);
});

test("applyCacheRetention: responses payload gains 24h, keeps everything else", () => {
	const payload = { model: "qwen3.8-flash", input: [{ role: "user" }], store: false, reasoning: { effort: "none" }, prompt_cache_key: "pk" };
	const next = applyCacheRetention(payload, { enabled: true, supportedModels: SUPPORTED, sessionId: "sess" }) as Record<string, unknown>;
	assert.equal(next.prompt_cache_retention, "24h");
	assert.equal(next.prompt_cache_key, "pk");
	assert.deepEqual(next.reasoning, { effort: "none" });
	assert.equal((payload as Record<string, unknown>).prompt_cache_retention, undefined, "original untouched");
});

test("applyCacheRetention: chat payload gains 24h + clamped session key", () => {
	const long = "x".repeat(100);
	const next = applyCacheRetention({ model: "MiniMax-M3", messages: [] }, {
		enabled: true,
		supportedModels: SUPPORTED,
		sessionId: long,
	}) as Record<string, unknown>;
	assert.equal(next.prompt_cache_retention, "24h");
	assert.equal(next.prompt_cache_key, "x".repeat(64));
	assert.equal(clampCacheKey(long).length, 64);
	// existing key preserved; missing session -> no key added
	const keep = applyCacheRetention({ model: "MiniMax-M3", messages: [], prompt_cache_key: "mine" }, {
		enabled: true,
		supportedModels: SUPPORTED,
		sessionId: "sess",
	}) as Record<string, unknown>;
	assert.equal(keep.prompt_cache_key, "mine");
	const noSess = applyCacheRetention({ model: "MiniMax-M3", messages: [] }, { enabled: true, supportedModels: SUPPORTED }) as Record<string, unknown>;
	assert.equal(noSess.prompt_cache_key, undefined);
});

test("applyCacheRetention: pi-sent retention is never doubled", () => {
	const payload = { model: "qwen3.8-flash", input: [], store: false, prompt_cache_retention: "24h" };
	assert.equal(applyCacheRetention(payload, { enabled: true, supportedModels: SUPPORTED, sessionId: "s" }), undefined);
});

test("retention sets derived from catalog compat flags", () => {
	assert.equal(RETENTION_MODELS.size, 12); // 7 responses + 5 chat routes accepted 24h
	for (const id of ["deepseek-v4-pro", "glm-5.3", "glm-5.3-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-flash", "qwen3.8-max", "kimi-k2.7-code", "kimi-k3", "MiniMax-M3", "hy3", "zhipu/glm-5.3"]) {
		assert.ok(RETENTION_MODELS.has(id), id);
	}
	assert.deepEqual([...NO_RETENTION_MODELS].sort(), ["deepseek-v4-flash", "doubao-seed-2.1-pro", "glm-5.2"]);
});

// ---------------------------------------------------------------------------
// autocomplete
// ---------------------------------------------------------------------------

test("completeArgs: first level, nested level, misses", () => {
	const commands = volcengineCommands();
	const all = completeArgs("", commands)!;
	assert.deepEqual(all.map((i) => i.value).sort(), ["cache ", "keys ", "models ", "status "].sort());
	assert.match(all.find((i) => i.value === "cache ")!.label, /^cache \[on\|off\|status\]/);

	assert.deepEqual(completeArgs("st", commands)!.map((i) => i.value), ["status "]);
	assert.equal(completeArgs("bogus", commands), null);

	const nested = completeArgs("cache", commands)!;
	assert.deepEqual(nested.map((i) => i.value), ["cache on", "cache off", "cache status"]);
	assert.deepEqual(completeArgs("cache o", commands)!.map((i) => i.value), ["cache on", "cache off"]);
	assert.equal(completeArgs("cache on x", commands), null);
	assert.equal(completeArgs("status x", commands), null); // no args -> no second level
});

// ---------------------------------------------------------------------------
// extension wiring: hook with settings, /volcengine command, status widget
// ---------------------------------------------------------------------------

test("hook injects retention only when settings/env say long", () => {
	const qwen = { model: "qwen3.8-flash", input: [], store: false };

	const off = loadExtension({ settingsFile: tmpSettingsFile({ version: 1, cacheRetention: "short" }) });
	const offHook = off.handlers.get("before_provider_request")![0];
	assert.equal(offHook({ type: "before_provider_request", payload: qwen }, fakeCtx().ctx), undefined);

	const on = loadExtension({ settingsFile: tmpSettingsFile({ version: 1, cacheRetention: "long" }) });
	const onHook = on.handlers.get("before_provider_request")![0];
	const rewritten = onHook({ type: "before_provider_request", payload: qwen }, fakeCtx().ctx) as Record<string, unknown>;
	assert.equal(rewritten.prompt_cache_retention, "24h");
	// responses payloads already carry prompt_cache_key from pi (short mode sends it)
	assert.equal(rewritten.prompt_cache_key, undefined);

	// strict model: strip hook still applies, retention never added
	const strict = { model: "deepseek-v4-flash", input: [], store: false, reasoning: { effort: "high", summary: "auto" } };
	const strictOut = onHook({ type: "before_provider_request", payload: strict }, fakeCtx().ctx) as Record<string, unknown>;
	assert.deepEqual(strictOut.reasoning, { effort: "high" });
	assert.equal(strictOut.prompt_cache_retention, undefined);

	// MiniMax chat: adaptive rewrite + retention + key composed in one pass
	const minimax = { model: "MiniMax-M3", messages: [], thinking: { type: "enabled" } };
	const minimaxOut = onHook({ type: "before_provider_request", payload: minimax }, fakeCtx().ctx) as Record<string, unknown>;
	assert.deepEqual(minimaxOut.thinking, { type: "adaptive" });
	assert.equal(minimaxOut.prompt_cache_retention, "24h");
	assert.equal(minimaxOut.prompt_cache_key, "sess-42");
});

test("hook honors PI_CACHE_RETENTION=long env over short settings", () => {
	process.env.PI_CACHE_RETENTION = "long";
	try {
		const fake = loadExtension({ settingsFile: tmpSettingsFile({ version: 1, cacheRetention: "short" }) });
		const hook = fake.handlers.get("before_provider_request")![0];
		const out = hook(
			{ type: "before_provider_request", payload: { model: "kimi-k2.7-code", messages: [] } },
			fakeCtx().ctx,
		) as Record<string, unknown>;
		assert.equal(out.prompt_cache_retention, "24h");
	} finally {
		delete process.env.PI_CACHE_RETENTION;
	}
});

test("/volcengine registered with description and autocomplete", () => {
	const fake = loadExtension({ settingsFile: tmpSettingsFile() });
	const command = fake.commands.get("volcengine")!;
	assert.ok(command);
	assert.match(command.description!, /status/i);
	const completions = command.getArgumentCompletions!("ca") as { value: string }[];
	assert.deepEqual(completions.map((i) => i.value), ["cache "]);
});

test("/volcengine usage and unknown subcommand", async () => {
	const fake = loadExtension({ settingsFile: tmpSettingsFile() });
	const handler = fake.commands.get("volcengine")!.handler;
	const { ctx, notifications } = fakeCtx();
	await handler("", ctx as never);
	assert.match(notifications[0]!.message, /status \u2014/);
	assert.match(notifications[0]!.message, /cache \[on\|off\|status\]/);
	await handler("bogus", ctx as never);
	assert.match(notifications[1]!.message, /Unknown command "bogus"/);
});

test("/volcengine status reports url, key, cache, models, current", async () => {
	const file = tmpSettingsFile({ version: 1, cacheRetention: "long" });
	const fake = loadExtension({ settingsFile: file });
	const handler = fake.commands.get("volcengine")!.handler;
	const { ctx, notifications } = fakeCtx({ model: { id: "glm-5.2", provider: PROVIDER_ID, api: "openai-responses" } });
	await handler("status", ctx as never);
	const message = notifications[0]!.message;
	assert.match(message, /base URL: https:\/\//);
	assert.match(message, /key: configured \(stored\)/);
	assert.match(message, /cache retention: long/);
	assert.match(message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(message, /models: 1/);
	assert.match(message, /glm-5\.2 \(openai-responses, no 24h\)/);
});

test("/volcengine cache on|off persists settings and updates hook behavior", async () => {
	const file = tmpSettingsFile();
	const fake = loadExtension({ settingsFile: file });
	const handler = fake.commands.get("volcengine")!.handler;
	const hook = fake.handlers.get("before_provider_request")![0];
	const { ctx, notifications, statuses } = fakeCtx({ hasUI: true, model: { id: "qwen3.8-flash", provider: PROVIDER_ID } });

	const payload = { model: "qwen3.8-flash", input: [], store: false };
	assert.equal(hook({ type: "before_provider_request", payload }, ctx), undefined, "short by default");

	await handler("cache on", ctx as never);
	assert.equal(loadSettings(file).cacheRetention, "long");
	assert.match(notifications[0]!.message, /24h cache retention enabled/);
	const out = hook({ type: "before_provider_request", payload }, ctx) as Record<string, unknown>;
	assert.equal(out.prompt_cache_retention, "24h", "hook picks up new setting immediately");
	assert.deepEqual(statuses.at(-1), { key: "volcengine-gateway", text: "volc:cache-long" });

	await handler("cache off", ctx as never);
	assert.equal(loadSettings(file).cacheRetention, "short");
	assert.match(notifications[1]!.message, /pi defaults/);
	assert.equal(hook({ type: "before_provider_request", payload }, ctx), undefined);

	await handler("cache bogus", ctx as never);
	assert.equal(notifications[2]!.type, "warning");

	await handler("cache status", ctx as never);
	assert.match(notifications[3]!.message, /cache retention: short/);
	assert.match(notifications[3]!.message, /24h routes \(12\)/);
	assert.match(notifications[3]!.message, /deepseek-v4-flash, doubao-seed-2\.1-pro, glm-5\.2/);
});

test("/volcengine keys check validates via zero-inference probe", async () => {
	const { impl, calls } = fetchStub({ status: 400 });
	const fake = loadExtension({ settingsFile: tmpSettingsFile(), fetchImpl: impl });
	const handler = fake.commands.get("volcengine")!.handler;
	const { ctx, notifications } = fakeCtx();
	await handler("keys check", ctx as never);
	assert.equal(calls.length, 1);
	assert.match(calls[0]!.url, /\/responses$/);
	assert.equal(calls[0]!.init?.body, "{}");
	assert.deepEqual((calls[0]!.init?.headers as Record<string, string>).Authorization, "Bearer test-key");
	assert.match(notifications.at(-1)!.message, /VALID/);

	// rejected key
	const bad = fetchStub({ status: 401 });
	const fake2 = loadExtension({ settingsFile: tmpSettingsFile(), fetchImpl: bad.impl });
	const { ctx: ctx2, notifications: n2 } = fakeCtx();
	await fake2.commands.get("volcengine")!.handler("keys check", ctx2 as never);
	assert.equal(n2.at(-1)!.type, "error");
	assert.match(n2.at(-1)!.message, /REJECTED/);

	// no key at all
	const fake3 = loadExtension({ settingsFile: tmpSettingsFile() });
	const { ctx: ctx3, notifications: n3 } = fakeCtx({
		modelRegistry: {
			getAll: () => [],
			getProviderAuthStatus: () => ({ configured: false }),
			getApiKeyForProvider: async () => undefined,
			refresh: async () => ({ aborted: false, errors: new Map() }),
		},
	});
	await fake3.commands.get("volcengine")!.handler("keys check", ctx3 as never);
	assert.equal(n3.at(-1)!.type, "warning");
	assert.match(n3.at(-1)!.message, /No API key/);

	// unknown subcommand
	await fake3.commands.get("volcengine")!.handler("keys rotate", ctx3 as never);
	assert.match(n3.at(-1)!.message, /Unknown keys subcommand/);
});

test("/volcengine models refresh forces provider-scoped network refresh", async () => {
	const fake = loadExtension({ settingsFile: tmpSettingsFile() });
	const handler = fake.commands.get("volcengine")!.handler;
	const { ctx, notifications, refreshCalls } = fakeCtx();
	await handler("models refresh", ctx as never);
	assert.equal(refreshCalls.length, 1);
	assert.deepEqual(refreshCalls[0], {
		allowNetwork: true,
		providers: [PROVIDER_ID],
		force: true,
		signal: ctx.signal,
	});
	assert.match(notifications.at(-1)!.message, /Catalog refreshed: 1 models/);

	// failure path keeps previous catalog
	const failing = loadExtension({ settingsFile: tmpSettingsFile() });
	const { ctx: ctx2, notifications: n2 } = fakeCtx({
		modelRegistry: {
			getAll: () => [{ id: "qwen3.8-flash", provider: PROVIDER_ID }],
			getProviderAuthStatus: () => ({ configured: true }),
			getApiKeyForProvider: async () => "k",
			refresh: async () => ({ aborted: false, errors: new Map([[PROVIDER_ID, new Error("boom")]]) }),
		},
	});
	await failing.commands.get("volcengine")!.handler("models refresh", ctx2 as never);
	assert.equal(n2.at(-1)!.type, "warning");
	assert.match(n2.at(-1)!.message, /refresh failed \(boom\)/);
});

test("status widget tracks model selection and cache mode", () => {
	const file = tmpSettingsFile({ version: 1, cacheRetention: "long" });
	const fake = loadExtension({ settingsFile: file });
	const modelSelect = fake.handlers.get("model_select")![0];
	assert.ok(fake.handlers.get("session_start")!.length === 1);
	assert.ok(fake.handlers.get("thinking_level_select")!.length === 1);

	const { ctx, statuses } = fakeCtx({ hasUI: true, model: { id: "qwen3.8-flash", provider: PROVIDER_ID } });
	modelSelect({ type: "model_select" }, ctx);
	assert.deepEqual(statuses.at(-1), { key: "volcengine-gateway", text: "volc:cache-long" });

	// unsupported model marks n/a
	const { ctx: ctx2, statuses: s2 } = fakeCtx({ hasUI: true, model: { id: "glm-5.2", provider: PROVIDER_ID } });
	modelSelect({ type: "model_select" }, ctx2);
	assert.deepEqual(s2.at(-1), { key: "volcengine-gateway", text: "volc:cache-long (n/a)" });

	// other provider clears the widget
	const { ctx: ctx3, statuses: s3 } = fakeCtx({ hasUI: true, model: { id: "gpt-5.5", provider: "openai" } });
	modelSelect({ type: "model_select" }, ctx3);
	assert.deepEqual(s3.at(-1), { key: "volcengine-gateway", text: undefined });

	// no UI -> no calls
	const { ctx: ctx4, statuses: s4 } = fakeCtx({ hasUI: false, model: { id: "qwen3.8-flash", provider: PROVIDER_ID } });
	modelSelect({ type: "model_select" }, ctx4);
	assert.equal(s4.length, 0);
});

test("settings file is created on first save with defaults intact", () => {
	const file = join(tmp, `fresh-${tmpCounter++}.json`);
	assert.equal(existsSync(file), false);
	assert.deepEqual(loadSettings(file), { version: 1, cacheRetention: "short" });
	const saved: VolcengineSettings = saveSettings({ cacheRetention: "long" }, file);
	assert.equal(saved.version, 1);
	assert.match(readFileSync(file, "utf8"), /"cacheRetention": "long"/);
});
