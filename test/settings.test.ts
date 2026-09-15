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
	BASE_URL_ENV,
	baseUrlSource,
	DEFAULT_BASE_URL,
	describeProbe,
	NO_RETENTION_MODELS,
	PROVIDER_ID,
	probeBaseUrl,
	resolveBaseUrl,
	RETENTION_MODELS,
	type VolcCtx,
} from "../index.ts";
import {
	applyCacheRetention,
	clampCacheKey,
	completeArgs,
	DEFAULT_SETTINGS,
	loadSettings,
	normalizeBaseUrl,
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
	const dialogs = {
		inputCalls: [] as { title: string; placeholder?: string }[],
		confirmCalls: [] as { title: string; message: string }[],
		inputResponse: undefined as string | undefined,
		confirmResponse: true,
	};
	const ctx: VolcCtx = {
		hasUI: false,
		ui: {
			notify(message: string, type?: "info" | "warning" | "error") {
				notifications.push({ message, type });
			},
			setStatus(key: string, text: string | undefined) {
				statuses.push({ key, text });
			},
			async input(title: string, placeholder?: string) {
				dialogs.inputCalls.push({ title, placeholder });
				return dialogs.inputResponse;
			},
			async select() {
				return undefined;
			},
			async confirm(title: string, message: string) {
				dialogs.confirmCalls.push({ title, message });
				return dialogs.confirmResponse;
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
	return { ctx, notifications, statuses, refreshCalls, dialogs };
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
	assert.deepEqual(all.map((i) => i.value).sort(), ["cache ", "keys ", "models ", "status ", "url "].sort());
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

// ---------------------------------------------------------------------------
// endpoint URL override + detection
// ---------------------------------------------------------------------------

const GOOD_URL = "https://gw.example.volceapi.com/v1";

test("normalizeBaseUrl matrix", () => {
	assert.equal(normalizeBaseUrl(" https://a.b/v1// "), "https://a.b/v1");
	assert.equal(normalizeBaseUrl("http://a.b/v1"), "http://a.b/v1");
	assert.equal(normalizeBaseUrl("HTTP://A.B/v1"), "HTTP://A.B/v1"); // scheme case preserved
	assert.equal(normalizeBaseUrl("ftp://a.b"), undefined);
	assert.equal(normalizeBaseUrl("a.b/v1"), undefined); // no scheme
	assert.equal(normalizeBaseUrl("https://a.b/v 1"), undefined); // inner space
	assert.equal(normalizeBaseUrl("https://not a url"), undefined);
	assert.equal(normalizeBaseUrl(""), undefined);
	assert.equal(normalizeBaseUrl(null), undefined);
	assert.equal(normalizeBaseUrl(undefined), undefined);
});

test("settings store round-trips baseUrl; junk dropped; null clears", () => {
	const file = tmpSettingsFile();
	const saved = saveSettings({ baseUrl: `${GOOD_URL}/` }, file);
	assert.equal(saved.baseUrl, GOOD_URL, "trailing slash normalized");
	assert.equal(loadSettings(file).baseUrl, GOOD_URL);
	// junk in file is dropped on load, not fatal
	const junkFile = tmpSettingsFile({ version: 1, cacheRetention: "short", baseUrl: "ftp://x" });
	assert.equal(loadSettings(junkFile).baseUrl, undefined);
	// null clears, other fields preserved
	saveSettings({ cacheRetention: "long" }, file);
	const cleared = saveSettings({ baseUrl: null }, file);
	assert.equal(cleared.baseUrl, undefined);
	assert.equal(cleared.cacheRetention, "long", "cache setting untouched by url clear");
});

test("resolveBaseUrl precedence: env > settings > default", () => {
	const settings = { baseUrl: GOOD_URL };
	assert.equal(resolveBaseUrl({}, settings), GOOD_URL);
	assert.equal(resolveBaseUrl({ [BASE_URL_ENV]: "https://env.example/v1/" }, settings), "https://env.example/v1");
	assert.equal(resolveBaseUrl({}, {}), DEFAULT_BASE_URL);
	assert.equal(resolveBaseUrl({}, undefined), DEFAULT_BASE_URL);
	assert.equal(baseUrlSource({ [BASE_URL_ENV]: "https://env.example/v1" }, settings), "env");
	assert.equal(baseUrlSource({}, settings), "settings");
	assert.equal(baseUrlSource({}, {}), "default");
	// whitespace-only env does not count
	assert.equal(baseUrlSource({ [BASE_URL_ENV]: "   " }, settings), "settings");
});

test("probeBaseUrl classifies gateway responses without throwing", async () => {
	const ok = fetchStub({ status: 200, body: { object: "list", data: [{ id: "a" }, { id: "b" }] } });
	const r1 = await probeBaseUrl(GOOD_URL, { apiKey: "k", fetchImpl: ok.impl });
	assert.deepEqual(r1, { status: "ok", models: 2 });
	assert.equal(ok.calls[0]!.url, `${GOOD_URL}/models`);
	assert.equal((ok.calls[0]!.init?.headers as Record<string, string>).Authorization, "Bearer k");

	const denied = fetchStub({ status: 401 });
	assert.deepEqual(await probeBaseUrl(GOOD_URL, { apiKey: "k", fetchImpl: denied.impl }), { status: "auth" });
	assert.deepEqual(await probeBaseUrl(GOOD_URL, { fetchImpl: denied.impl }), { status: "reachable" }, "no key + 401 = alive");

	const bad = fetchStub({ status: 200, body: { hello: "world" } });
	const r2 = await probeBaseUrl(GOOD_URL, { apiKey: "k", fetchImpl: bad.impl });
	assert.equal(r2.status, "unexpected");

	const serverErr = fetchStub({ status: 502 });
	assert.deepEqual(await probeBaseUrl(GOOD_URL, { apiKey: "k", fetchImpl: serverErr.impl }), {
		status: "unexpected",
		reason: "HTTP 502",
	});

	const offline = fetchStub(new Error("connect ENETUNREACH"));
	const r3 = await probeBaseUrl(GOOD_URL, { apiKey: "k", fetchImpl: offline.impl });
	assert.equal(r3.status, "unreachable");
	assert.match((r3 as { reason?: string }).reason!, /ENETUNREACH/);
});

test("describeProbe maps status to message/type", () => {
	assert.equal(describeProbe({ status: "ok", models: 15 }, GOOD_URL).type, "info");
	assert.match(describeProbe({ status: "ok", models: 15 }, GOOD_URL).message, /LIVE — GET \/models returned 15/);
	assert.equal(describeProbe({ status: "reachable" }, GOOD_URL).type, "warning");
	assert.equal(describeProbe({ status: "auth" }, GOOD_URL).type, "error");
	assert.match(describeProbe({ status: "auth" }, GOOD_URL).message, /REJECTED/);
	assert.equal(describeProbe({ status: "unexpected", reason: "HTTP 502" }, GOOD_URL).type, "warning");
	assert.equal(describeProbe({ status: "unreachable" }, GOOD_URL).type, "error");
});

test("provider + status + keys check honor the persisted endpoint", async () => {
	const file = tmpSettingsFile({ version: 1, cacheRetention: "short", baseUrl: GOOD_URL });
	const { impl, calls } = fetchStub({ status: 400 });
	const fake = loadExtension({ settingsFile: file, fetchImpl: impl });
	const provider = fake.providers.get(PROVIDER_ID) as { baseUrl: string; getModels(): { baseUrl: string }[] };
	assert.equal(provider.baseUrl, GOOD_URL, "provider bound to settings URL");
	assert.equal(provider.getModels()[0]!.baseUrl, GOOD_URL, "models baked with settings URL");

	const handler = fake.commands.get("volcengine")!.handler;
	const { ctx, notifications } = fakeCtx();
	await handler("status", ctx as never);
	assert.match(notifications[0]!.message, new RegExp(`base URL: ${GOOD_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(settings\\)`));

	await handler("keys check", ctx as never);
	assert.equal(calls[0]!.url, `${GOOD_URL}/responses`, "key probe uses settings URL");
});

function boundProvider(fake: FakePi) {
	return fake.providers.get(PROVIDER_ID) as {
		baseUrl: string;
		rebindBaseUrl(url: string): void;
		persistEndpoint(url: string): void;
		getModels(): { baseUrl: string }[];
	};
}

test("/volcengine url status shows source and env shadowing", async () => {
	const file = tmpSettingsFile({ version: 1, cacheRetention: "short", baseUrl: GOOD_URL });
	const fake = loadExtension({ settingsFile: file });
	const handler = fake.commands.get("volcengine")!.handler;

	const { ctx, notifications } = fakeCtx();
	await handler("url status", ctx as never);
	assert.match(notifications[0]!.message, /endpoint: https:\/\/gw\.example\.volceapi\.com\/v1/);
	assert.match(notifications[0]!.message, /source: settings/);
	assert.match(notifications[0]!.message, new RegExp(`default: ${DEFAULT_BASE_URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));

	// bare `url` == status
	await handler("url", ctx as never);
	assert.match(notifications[1]!.message, /endpoint:/);

	// env shadows the saved override and says so
	process.env[BASE_URL_ENV] = "https://env.example/v1";
	try {
		await handler("url status", ctx as never);
		const msg = notifications[2]!.message;
		assert.match(msg, /endpoint: https:\/\/env\.example\/v1/);
		assert.match(msg, /source: env/);
		assert.match(msg, new RegExp(`saved override \\(shadowed by env\\): ${GOOD_URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
	} finally {
		delete process.env[BASE_URL_ENV];
	}
});

test("/volcengine url check probes without saving", async () => {
	const file = tmpSettingsFile();
	const { impl, calls } = fetchStub({ status: 200, body: { data: [{ id: "m1" }] } });
	const fake = loadExtension({ settingsFile: file, fetchImpl: impl });
	const handler = fake.commands.get("volcengine")!.handler;
	const { ctx, notifications, dialogs } = fakeCtx();

	await handler(`url check ${GOOD_URL}/`, ctx as never);
	assert.equal(calls[0]!.url, `${GOOD_URL}/models`, "normalized before probing");
	assert.match(notifications[0]!.message, /Probing/);
	assert.match(notifications[1]!.message, /LIVE — GET \/models returned 1 models/);
	assert.equal(loadSettings(file).baseUrl, undefined, "nothing persisted");

	// check without argument probes the effective endpoint
	await handler("url check", ctx as never);
	assert.equal(calls[1]!.url, `${DEFAULT_BASE_URL}/models`);
});

test("/volcengine url set: verified save + in-place rebind; already-effective no-op", async () => {
	const file = tmpSettingsFile();
	const { impl } = fetchStub({ status: 200, body: { data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] } });
	const fake = loadExtension({ settingsFile: file, fetchImpl: impl });
	const handler = fake.commands.get("volcengine")!.handler;
	const { ctx, notifications } = fakeCtx();

	await handler(`url set ${GOOD_URL}`, ctx as never);
	assert.equal(loadSettings(file).baseUrl, GOOD_URL);
	assert.match(notifications.at(-1)!.message, /verified \(GET \/models → 200, 3 models\), saved/);
	assert.match(notifications.at(-1)!.message, /bound in-place/);
	const provider = boundProvider(fake);
	assert.equal(provider.baseUrl, GOOD_URL, "provider rebound without reload");
	assert.ok(provider.getModels().every((m) => m.baseUrl === GOOD_URL), "all live models rebound");

	// setting the default URL while on default is a no-op
	const file2 = tmpSettingsFile();
	const fake2 = loadExtension({ settingsFile: file2, fetchImpl: impl });
	const { ctx: ctx2, notifications: n2 } = fakeCtx();
	await fake2.commands.get("volcengine")!.handler(`url set ${DEFAULT_BASE_URL}/`, ctx2 as never);
	assert.match(n2.at(-1)!.message, /already the effective endpoint \(default\) — nothing to save/);
	assert.equal(loadSettings(file2).baseUrl, undefined);
	assert.equal(boundProvider(fake2).baseUrl, DEFAULT_BASE_URL);
});

test("/volcengine url set: rejected/unreachable probes go through confirm", async () => {
	// 401 with a key -> auth status -> confirm gate
	const denied = fetchStub({ status: 401 });
	const file = tmpSettingsFile();
	const fake = loadExtension({ settingsFile: file, fetchImpl: denied.impl });
	const handler = fake.commands.get("volcengine")!.handler;

	const yes = fakeCtx({ hasUI: true });
	yes.dialogs.confirmResponse = true;
	await handler(`url set ${GOOD_URL}`, yes.ctx as never);
	assert.equal(yes.dialogs.confirmCalls.length, 1);
	assert.match(yes.dialogs.confirmCalls[0]!.message, /REJECTED the current key/);
	assert.match(yes.dialogs.confirmCalls[0]!.message, /Save it anyway\?$/);
	assert.equal(loadSettings(file).baseUrl, GOOD_URL, "saved after confirm");
	assert.match(yes.notifications.at(-1)!.message, /Saved WITHOUT verification/);
	assert.equal(boundProvider(fake).baseUrl, GOOD_URL, "rebound after confirm");

	// decline -> not saved
	const no = fakeCtx({ hasUI: true });
	no.dialogs.confirmResponse = false;
	const file2 = tmpSettingsFile();
	const fake2 = loadExtension({ settingsFile: file2, fetchImpl: denied.impl });
	await fake2.commands.get("volcengine")!.handler(`url set ${GOOD_URL}`, no.ctx as never);
	assert.equal(loadSettings(file2).baseUrl, undefined);
	assert.match(no.notifications.at(-1)!.message, /NOT saved/);

	// headless (no UI): cannot confirm -> instructs, does not save
	const file3 = tmpSettingsFile();
	const fake3 = loadExtension({ settingsFile: file3, fetchImpl: fetchStub(new Error("offline")).impl });
	const headless = fakeCtx();
	await fake3.commands.get("volcengine")!.handler(`url set ${GOOD_URL}`, headless.ctx as never);
	assert.equal(loadSettings(file3).baseUrl, undefined);
	assert.match(headless.notifications.at(-1)!.message, /did not respond/);
	assert.match(headless.notifications.at(-1)!.message, new RegExp(`answer in the TUI, or export ${BASE_URL_ENV}=`));
});

test("/volcengine url set: invalid URL and interactive prompt paths", async () => {
	const file = tmpSettingsFile();
	const fake = loadExtension({ settingsFile: file });
	const handler = fake.commands.get("volcengine")!.handler;

	const { ctx, notifications } = fakeCtx();
	await handler("url set ftp://bad", ctx as never);
	assert.equal(notifications[0]!.type, "warning");
	assert.match(notifications[0]!.message, /Invalid endpoint URL "ftp:\/\/bad"/);

	// bare `set` without UI -> usage hint
	await handler("url set", ctx as never);
	assert.match(notifications[1]!.message, /interactive prompt needs the TUI/);

	// bare `set` with UI -> input dialog prefilled with current endpoint
	const { impl } = fetchStub({ status: 200, body: { data: [] } });
	const fake2 = loadExtension({ settingsFile: file, fetchImpl: impl });
	const tui = fakeCtx({ hasUI: true });
	tui.dialogs.inputResponse = `${GOOD_URL}/`;
	await fake2.commands.get("volcengine")!.handler("url set", tui.ctx as never);
	assert.equal(tui.dialogs.inputCalls.length, 1);
	assert.equal(tui.dialogs.inputCalls[0]!.placeholder, DEFAULT_BASE_URL);
	assert.equal(loadSettings(file).baseUrl, GOOD_URL, "prompted value normalized + saved");

	// cancelled dialog -> nothing happens
	const tui2 = fakeCtx({ hasUI: true });
	tui2.dialogs.inputResponse = undefined;
	await fake2.commands.get("volcengine")!.handler("url set", tui2.ctx as never);
	assert.match(tui2.notifications.at(-1)!.message, /Invalid endpoint URL ""/);

	await handler("url bogus", ctx as never);
	assert.match(notifications.at(-1)!.message, /Unknown url subcommand "bogus"/);
});

test("/volcengine url reset clears override and rebinds", async () => {
	const file = tmpSettingsFile({ version: 1, cacheRetention: "short", baseUrl: GOOD_URL });
	const fake = loadExtension({ settingsFile: file });
	const handler = fake.commands.get("volcengine")!.handler;
	const { ctx, notifications } = fakeCtx();

	await handler("url reset", ctx as never);
	assert.equal(loadSettings(file).baseUrl, undefined);
	assert.match(notifications[0]!.message, new RegExp(`Override cleared — now using ${DEFAULT_BASE_URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} \\(default\\)`));
	assert.match(notifications[0]!.message, /bound in-place/);
	assert.equal(boundProvider(fake).baseUrl, DEFAULT_BASE_URL, "models rebound to default");

	// idempotent second reset
	await handler("url reset", ctx as never);
	assert.match(notifications[1]!.message, /No saved endpoint override/);
});

test("url subcommands appear in autocomplete", () => {
	const commands = volcengineCommands();
	assert.deepEqual(completeArgs("u", commands)!.map((i) => i.value), ["url "]);
	const nested = completeArgs("url", commands)!;
	assert.deepEqual(nested.map((i) => i.value), ["url status", "url set", "url check", "url reset"]);
	assert.deepEqual(completeArgs("url s", commands)!.map((i) => i.value), ["url status", "url set"]);
	// free-form URL after `set` disables completion
	assert.equal(completeArgs(`url set ${GOOD_URL}`, commands), null);
});

test("env override wins over persisted settings end-to-end", () => {
	process.env[BASE_URL_ENV] = "https://env.example/v1";
	try {
		const file = tmpSettingsFile({ version: 1, cacheRetention: "short", baseUrl: GOOD_URL });
		const fake = loadExtension({ settingsFile: file });
		const provider = fake.providers.get(PROVIDER_ID) as { baseUrl: string };
		assert.equal(provider.baseUrl, "https://env.example/v1");
	} finally {
		delete process.env[BASE_URL_ENV];
	}
});
