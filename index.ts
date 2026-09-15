/**
 * Volcengine API Gateway (volceapi.com) provider for the pi coding agent.
 *
 * Endpoint: per-subscriber API Gateway URL, e.g.
 *           https://<id>.apigateway-cn-beijing.volceapi.com/v1
 *           (override with $VOLCEAPI_BASE_URL, or persist one via
 *           `/volcengine url set https://…` — the candidate is probed
 *           before saving, like pi-alibaba-models' endpoint detection)
 * Auth:     `pi /login volcengine-gateway` (key is validated against the
 *           gateway before it is saved, stored in ~/.pi/agent/auth.json)
 *           or $VOLCEAPI_API_KEY. The login flow starts on the effective
 *           endpoint and, when the key is rejected (401 — which also happens
 *           for a VALID key against someone else's gateway) or the gateway is
 *           unreachable, offers "Change the endpoint URL…": the candidate is
 *           probed with the key, persisted to the settings store on accept,
 *           and live models are rebound in-place (pi keeps the same model
 *           object references, so no /reload is needed).
 *
 * Priority API surface: OpenAI **Responses API** (`/responses`, stateless
 * store:false). Models whose upstream vendor does not speak Responses on this
 * gateway (kimi-*, MiniMax-M3, hy3, zhipu/glm-5.3 — they 400 with
 * "messages"-style errors) are registered per-model on `openai-completions`.
 *
 * All facts below were verified against the live gateway on 2026-09-15:
 *
 * Responses quirks:
 *   - deepseek-v4-flash / doubao-seed-2.1-pro / glm-5.2 reject
 *     `reasoning.summary` ("json: unknown field \"summary\""), but pi-ai always
 *     sends `summary:"auto"` together with `reasoning.effort`. A
 *     `before_provider_request` hook strips `summary` for exactly these models.
 *     (deepseek-v4-pro / glm-5.3 / qwen* accept `summary`, so they keep it.)
 *   - effort values verified per model — see the *_EFFORT maps below.
 *     glm-5.3/5.3-flash & zhipu/glm-5.3 "always think": only low/high/max are
 *     accepted (low ⇒ ~zero reasoning); off/minimal/medium are rejected.
 *   - `store:false`, `include:["reasoning.encrypted_content"]` (no encrypted
 *     content is ever returned), `prompt_cache_key`, `max_output_tokens`,
 *     developer+system roles, function tools and streaming tool-call deltas
 *     all behave like OpenAI. Reasoning arrives both as
 *     `response.reasoning_text.delta` SSE events (parsed by pi-ai) and as
 *     final `summary`/`content` on reasoning items.
 *   - The gateway truncates qwen input at 800k tokens (verified: 1.05M and
 *     1.2M-token inputs both report usage_in=800054).
 *
 * Chat-completions quirks:
 *   - MiniMax-M3 accepts only `thinking:{type:"adaptive"|"disabled"}`
 *     ("enabled" is rejected) — a `before_provider_request` hook rewrites
 *     pi-ai's deepseek-format `{type:"enabled"}` to `{type:"adaptive"}`.
 *   - hy3 natively supports `thinking:{type:"enabled"|"disabled"}`.
 *   - kimi-k2.7-code / kimi-k3 cannot disable or steer thinking
 *     (enable_thinking / thinking.type / reasoning_effort are all ignored).
 *   - zhipu/glm-5.3 steers thinking via `reasoning_effort` low/high/max only.
 *   - All chat routes stream `reasoning_content`, honor
 *     `stream_options.include_usage`, accept `strict:false` tools and
 *     `max_completion_tokens`; kimi tool-call round-trips verified.
 *
 * Prompt caching: implicit prefix caching works gateway-wide (repeat of a
 * ~2.8k-token prompt returns cached_tokens 2048–2816 on qwen3.8-flash,
 * kimi-k2.7-code and glm-5.3-flash). `prompt_cache_retention:"24h"`
 * (sent by pi only under PI_CACHE_RETENTION=long) is accepted by all chat
 * routes and by deepseek-v4-pro/glm-5.3/glm-5.3-flash/qwen*, but rejected
 * ("json: unknown field") by deepseek-v4-flash/doubao-seed-2.1-pro/glm-5.2 —
 * those three keep supportsLongCacheRetention:false.
 *
 * Key validation (zero inference): POST {} to /responses returns
 * 400 "AI request body should have string model field." for a VALID key and
 * 401 "Consumer authentication failed." for an invalid one.
 *
 * Context windows / max output tokens: from gateway 400-error caps where
 * available (kimi 262144/1048576, MiniMax 524288, zhipu 131072, hy3 input
 * 192000, deepseek-v4-flash 393216, doubao 262144, glm 131072, qwen3.7
 * 131072), otherwise from the official Ark routes of the reference extensions.
 *
 * Billing: the gateway reports a per-model `credit` multiplier via
 * GET /v1/models (changes over time — credit_history). 1 credit ≈ $1 per 1M
 * tokens (scale-matched against public Ark pricing); costs below use the
 * credits observed on 2026-09-15. Cache reads are priced at the input rate
 * (cached_tokens confirmed in usage; gateway billing split unknown — same
 * convention as the reference volc extensions). When the network is allowed, pi refreshes
 * the catalog via fetchModels (GET /v1/models): fresh names/credits, new
 * gateway models auto-registered with conservative defaults, persisted to
 * pi's models store for offline starts. The dynamic overlay upserts over the
 * static baseline, so models removed from the gateway linger until this
 * extension is updated.
 *
 * Usage:
 *   pi                        # /login volcengine-gateway, then /model
 *   export VOLCEAPI_API_KEY=… # alternative to /login
 *   /volcengine status        # in-pi settings: base URL, key, cache, catalog
 *   /volcengine cache on      # persist 24h prompt-cache retention (verified
 *                             # routes only); PI_CACHE_RETENTION=long also works
 *   /volcengine keys check    # validate the resolved key against the gateway
 *   /volcengine models refresh# force GET /v1/models catalog refresh
 */

import {
	createProvider,
	type ApiKeyCredential,
	type AuthContext,
	type Model,
	type ProviderAuthInteraction,
	type RefreshModelsContext,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyCacheRetention,
	completeArgs,
	formatCommandLine,
	loadSettings,
	normalizeBaseUrl,
	parseCacheArg,
	saveSettings,
	settingsPath,
	volcengineCommands,
	type CacheRetentionMode,
	type VolcengineSettings,
} from "./settings.ts";

export const PROVIDER_ID = "volcengine-gateway";
export const DEFAULT_BASE_URL = "https://YOUR-GATEWAY-ID.apigateway-cn-beijing.volceapi.com/v1";
export const API_KEY_ENV = "VOLCEAPI_API_KEY";
export const BASE_URL_ENV = "VOLCEAPI_BASE_URL";

/** Timeout for the zero-inference key-validation probe. */
const KEY_VALIDATION_TIMEOUT_MS = 12_000;
/** Timeout for the GET /models catalog fetch. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Effective endpoint: $VOLCEAPI_BASE_URL env > persisted settings override
 * (`/volcengine url set`) > built-in default. Same precedence stance as
 * pi-alibaba-models' resolvePlanEndpoints (explicit source beats config,
 * config beats default).
 */
export function resolveBaseUrl(
	env: NodeJS.ProcessEnv = process.env,
	settings?: { baseUrl?: string },
): string {
	const override = env[BASE_URL_ENV]?.trim() || settings?.baseUrl?.trim();
	if (override) return override.replace(/\/+$/, "");
	return DEFAULT_BASE_URL;
}

export function baseUrlSource(
	env: NodeJS.ProcessEnv = process.env,
	settings?: { baseUrl?: string },
): "env" | "settings" | "default" {
	if (env[BASE_URL_ENV]?.trim()) return "env";
	if (settings?.baseUrl?.trim()) return "settings";
	return "default";
}

type GatewayApi = "openai-responses" | "openai-completions";
type CatalogEntry = Omit<Model<GatewayApi>, "provider" | "baseUrl">;

// ---------------------------------------------------------------------------
// compat blocks
// ---------------------------------------------------------------------------

/** Verified on every /responses route: developer role OK, strict tools not needed.
 *  supportsLongCacheRetention:true — `prompt_cache_retention:"24h"` accepted (200)
 *  on deepseek-v4-pro, glm-5.3, glm-5.3-flash and all four qwen routes
 *  (probe 2026-09-15). pi only sends it under PI_CACHE_RETENTION=long. */
const RESPONSES_COMPAT = {
	supportsDeveloperRole: true,
	supportsLongCacheRetention: true,
	supportsStrictMode: false,
};

/** deepseek-v4-flash / doubao-seed-2.1-pro / glm-5.2 reject unknown JSON
 *  fields outright: `prompt_cache_retention` 400s with
 *  "json: unknown field" (same strictness as their `reasoning.summary`
 *  rejection) — retention must stay disabled for them. */
const RESPONSES_STRICT_COMPAT = { ...RESPONSES_COMPAT, supportsLongCacheRetention: false };

/** Verified on every /chat/completions route: system role, no `store`,
 *  usage-in-streaming via stream_options, max_completion_tokens accepted.
 *  supportsLongCacheRetention:true — all 5 chat routes accepted
 *  `prompt_cache_retention:"24h"` (200, probe 2026-09-15). */
const CHAT_COMPAT = {
	supportsDeveloperRole: false,
	supportsStore: false,
	supportsUsageInStreaming: true,
	supportsLongCacheRetention: true,
	maxTokensField: "max_completion_tokens" as const,
};

// ---------------------------------------------------------------------------
// thinking level maps (pi level -> provider value; null = level unavailable)
// ---------------------------------------------------------------------------

/** deepseek-v4-*: none/minimal/low/medium/high all verified; none ⇒ rt=0. */
const DEEPSEEK_EFFORT = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
	max: "high",
} satisfies ThinkingLevelMap;

/** doubao-seed-2.1-pro: none/minimal/low/medium/high verified; none ⇒ rt=0. */
const DOUBAO_EFFORT = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
	max: "high",
} satisfies ThinkingLevelMap;

/** glm-5.2: every value verified incl. max; none/minimal ⇒ rt=0. */
const GLM52_EFFORT = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "max",
	max: "max",
} satisfies ThinkingLevelMap;

/** glm-5.3 / glm-5.3-flash: "always thinks" — gateway rejects off/minimal/
 *  medium; only low/high/max (low ⇒ ~zero reasoning tokens). */
const GLM53_EFFORT = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: "max",
	max: "max",
} satisfies ThinkingLevelMap;

/** qwen3.7/3.8: none/minimal/low/medium/high/max verified (none ⇒ rt=0). */
const QWEN_EFFORT = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "max",
	max: "max",
} satisfies ThinkingLevelMap;

/** kimi-*: thinking cannot be disabled or steered on this gateway; expose a
 *  single nominal "high" so the level picker has an entry, send nothing. */
const KIMI_UNCONTROLLABLE = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: null,
} satisfies ThinkingLevelMap;

/** zhipu/glm-5.3 (chat route): reasoning_effort accepts only low/high/max
 *  (low ⇒ ~zero reasoning); minimal/medium/off rejected — always thinks. */
const ZHIPU_EFFORT = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: "max",
	max: "max",
} satisfies ThinkingLevelMap;

/** Models whose upstream rejects `reasoning.summary` on /responses — the
 *  before_provider_request hook strips it from their payloads. */
export const STRIP_REASONING_SUMMARY = new Set(["deepseek-v4-flash", "doubao-seed-2.1-pro", "glm-5.2"]);

/** Gateway smart-routing pseudo-entry that must never be registered. */
const SKIP_MODEL_IDS = new Set(["auto"]);

/** Credits observed via GET /v1/models on 2026-09-15 (≈ $/1M tokens).
 *  cacheRead priced at the input rate: cached_tokens confirmed in usage on
 *  qwen/kimi/glm repeats; the gateway does not expose a cache discount. */
function credits(credit: number): Model<GatewayApi>["cost"] {
	return { input: credit, output: credit, cacheRead: credit, cacheWrite: 0 };
}

// ---------------------------------------------------------------------------
// static catalog (verified against the live gateway on 2026-09-15)
// ---------------------------------------------------------------------------

export const CATALOG: CatalogEntry[] = [
	// ---- Responses API ----
	{
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...DEEPSEEK_EFFORT },
		input: ["text"],
		cost: credits(0.33),
		contextWindow: 1_000_000,
		maxTokens: 393_216, // gateway cap: "max_output_tokens <= 393216"
		compat: { ...RESPONSES_STRICT_COMPAT }, // rejects prompt_cache_retention
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...DEEPSEEK_EFFORT },
		input: ["text"],
		cost: credits(0.99),
		contextWindow: 1_000_000,
		maxTokens: 393_216,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "doubao-seed-2.1-pro",
		name: "Doubao Seed 2.1 Pro",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...DOUBAO_EFFORT },
		input: ["text", "image"], // vision verified
		cost: credits(1.85),
		contextWindow: 256_000, // >256k input rejected ("exceed max message tokens")
		maxTokens: 262_144, // gateway cap
		compat: { ...RESPONSES_STRICT_COMPAT }, // rejects prompt_cache_retention
	},
	{
		id: "glm-5.2",
		name: "GLM 5.2",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...GLM52_EFFORT },
		input: ["text"], // image input yields empty output on this route
		cost: credits(1.46),
		contextWindow: 1_000_000,
		maxTokens: 131_072, // gateway cap
		compat: { ...RESPONSES_STRICT_COMPAT }, // rejects prompt_cache_retention
	},
	{
		id: "glm-5.3",
		name: "GLM 5.3",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...GLM53_EFFORT },
		input: ["text"], // image input is ignored by the model on this route
		cost: credits(1.95),
		contextWindow: 1_000_000,
		maxTokens: 131_072, // gateway cap: "限制数值范围[1,131072]"
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "glm-5.3-flash",
		name: "GLM 5.3 Flash",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...GLM53_EFFORT },
		input: ["text", "image"], // vision verified
		cost: credits(0.22),
		contextWindow: 1_000_000,
		maxTokens: 131_072, // gateway cap
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "qwen3.7-max",
		name: "Qwen3.7-Max",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text"], // gateway: "only supports text modality"
		cost: credits(2.64),
		contextWindow: 800_000, // gateway truncates qwen input at 800k (verified)
		maxTokens: 131_072, // gateway cap: "Range of max_tokens should be [1, 131072]"
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "qwen3.7-plus",
		name: "Qwen3.7-Plus",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text", "image"], // vision verified
		cost: credits(0.59),
		contextWindow: 800_000, // accepted 800k input probe
		maxTokens: 131_072, // gateway cap
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "qwen3.8-flash",
		name: "Qwen3.8-Flash",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text", "image"], // vision verified
		cost: credits(0.19),
		contextWindow: 800_000, // accepted 800k input probe (truncation cap)
		maxTokens: 131_072, // qwen family cap
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "qwen3.8-max",
		name: "Qwen3.8-Max",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text", "image"], // vision verified
		cost: credits(2.84),
		contextWindow: 800_000, // family assumption (3.8-flash verified at 800k)
		maxTokens: 131_072, // qwen family cap
		compat: { ...RESPONSES_COMPAT },
	},
	// ---- Chat completions (upstreams without Responses support) ----
	{
		id: "kimi-k2.7-code",
		name: "Kimi K2.7 Code",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { ...KIMI_UNCONTROLLABLE },
		input: ["text", "image"], // vision verified via chat
		cost: credits(1.94),
		contextWindow: 262_144,
		maxTokens: 262_144, // gateway cap: "Range of max_tokens should be [1, 262144]"
		compat: { ...CHAT_COMPAT, supportsReasoningEffort: false, requiresReasoningContentOnAssistantMessages: true },
	},
	{
		id: "kimi-k3",
		name: "Kimi K3",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { ...KIMI_UNCONTROLLABLE },
		input: ["text", "image"], // vision verified via chat
		cost: credits(4.51),
		contextWindow: 1_024_000,
		maxTokens: 128_000, // gateway gate allows 1048576; Ark-route verified value kept
		compat: { ...CHAT_COMPAT, supportsReasoningEffort: false, requiresReasoningContentOnAssistantMessages: true },
	},
	{
		id: "MiniMax-M3",
		name: "MiniMax-M3",
		api: "openai-completions",
		reasoning: true,
		// deepseek format: off -> thinking:{type:"disabled"} (verified),
		// on -> {type:"enabled"} which the payload hook rewrites to "adaptive".
		input: ["text", "image"], // vision verified via chat
		cost: credits(1.47),
		contextWindow: 512_000,
		maxTokens: 524_288, // gateway cap: "does not support max tokens > 524288"
		compat: { ...CHAT_COMPAT, thinkingFormat: "deepseek", supportsReasoningEffort: false },
	},
	{
		id: "hy3",
		name: "Hy3",
		api: "openai-completions",
		reasoning: true,
		// deepseek format natively: on -> {type:"enabled"}, off -> {type:"disabled"} (both verified)
		input: ["text"], // image input produces no usable answer
		cost: credits(0.75),
		contextWindow: 192_000, // gateway: "Input tokens exceed the configured limit of 192000"
		maxTokens: 32_768, // unvalidated route; sane default
		compat: { ...CHAT_COMPAT, thinkingFormat: "deepseek", supportsReasoningEffort: false },
	},
	{
		id: "zhipu/glm-5.3",
		name: "Zhipu GLM 5.3",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { ...ZHIPU_EFFORT },
		input: ["text"],
		cost: credits(2.77),
		contextWindow: 1_000_000, // assumption: same model as glm-5.3
		maxTokens: 131_072, // gateway cap: "max_tokens参数非法：限制数值范围[1,131072]"
		compat: { ...CHAT_COMPAT, supportsReasoningEffort: true },
	},
];

export function buildModels(baseUrl: string): Model<GatewayApi>[] {
	return CATALOG.map((entry) => ({ ...entry, provider: PROVIDER_ID, baseUrl }));
}

// ---------------------------------------------------------------------------
// dynamic catalog (GET /v1/models) merged over the static capability table
// ---------------------------------------------------------------------------

export interface GatewayModelEntry {
	id?: unknown;
	name?: unknown;
	credit?: unknown;
}

/** Conservative registration for gateway models this build has never seen. */
export function unknownModelConfig(id: string, baseUrl: string, name?: string, credit?: number): Model<GatewayApi> {
	return {
		id,
		name: name?.trim() || id,
		api: "openai-completions", // chat completions works for every gateway model
		provider: PROVIDER_ID,
		baseUrl,
		reasoning: true,
		// every level null => pi sends no thinking parameters at all
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
		input: ["text"],
		cost: credit !== undefined && credit > 0 ? credits(credit) : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		// CHAT_COMPAT carries supportsLongCacheRetention:true — every chat
		// route probed so far accepted prompt_cache_retention.
		compat: { ...CHAT_COMPAT, supportsReasoningEffort: false },
	};
}

/**
 * Merge the live GET /v1/models listing over the static catalog:
 * - known ids keep their verified caps/maps/compat, gain fresh name + credit
 * - unknown ids are auto-registered conservatively
 * - listed-but-unknown junk ("auto") is skipped
 * - an empty/invalid listing falls back to the static catalog
 */
export function mergeGatewayCatalog(raw: GatewayModelEntry[], baseUrl: string): Model<GatewayApi>[] {
	const known = new Map(CATALOG.map((entry) => [entry.id, entry]));
	const merged: Model<GatewayApi>[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		const id = typeof entry?.id === "string" ? entry.id.trim() : "";
		if (!id || SKIP_MODEL_IDS.has(id) || seen.has(id)) continue;
		seen.add(id);
		const name = typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
		const credit = typeof entry?.credit === "number" && Number.isFinite(entry.credit) ? entry.credit : undefined;
		const base = known.get(id);
		if (base) {
			merged.push({
				...base,
				name: name ?? base.name,
				cost: credit !== undefined && credit > 0 ? credits(credit) : base.cost,
				provider: PROVIDER_ID,
				baseUrl,
			});
		} else {
			merged.push(unknownModelConfig(id, baseUrl, name, credit));
		}
	}
	if (merged.length === 0) return buildModels(baseUrl);
	return merged;
}

/**
 * fetchModels for createProvider: pi restores/persists the returned overlay
 * transactionally (models store), so offline starts reuse the last fetched
 * catalog. Any failure degrades to the static baseline.
 */
export async function fetchGatewayModels(
	context: RefreshModelsContext,
	baseUrl: string,
	fetchImpl: typeof fetch = fetch,
): Promise<Model<GatewayApi>[]> {
	const fallback = buildModels(baseUrl);
	const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!key) return fallback;
	try {
		const response = await fetchImpl(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.any([context.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
		});
		if (!response.ok) return fallback;
		const data = (await response.json()) as { data?: GatewayModelEntry[] };
		if (!Array.isArray(data?.data) || data.data.length === 0) return fallback;
		return mergeGatewayCatalog(data.data, baseUrl);
	} catch {
		return fallback;
	}
}

// ---------------------------------------------------------------------------
// key validation + login flow
// ---------------------------------------------------------------------------

export interface KeyValidationResult {
	status: "valid" | "invalid" | "unavailable";
	reason?: string;
}

export interface ValidateKeyOptions {
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

/**
 * Zero-inference key check: POST {} to /responses.
 * 400 ("should have string model field") ⇒ the key authenticated;
 * 401/403 ⇒ rejected; anything else ⇒ gateway state unknown.
 * Never logs or returns the key.
 */
export async function validateGatewayKey(key: string, options: ValidateKeyOptions = {}): Promise<KeyValidationResult> {
	const baseUrl = options.baseUrl ?? resolveBaseUrl();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), KEY_VALIDATION_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	try {
		const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/responses`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
			body: "{}",
			signal,
		});
		if (response.status === 401 || response.status === 403) return { status: "invalid" };
		if (response.ok || response.status === 400) return { status: "valid" };
		return { status: "unavailable", reason: `HTTP ${response.status}` };
	} catch (error) {
		return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timeout);
	}
}

// ---------------------------------------------------------------------------
// endpoint detection (probe before switching — pi-alibaba-models pattern)
// ---------------------------------------------------------------------------

const ENDPOINT_PROBE_TIMEOUT_MS = 8_000;

export type EndpointProbe =
	| { status: "ok"; models: number }
	/** Alive, but demanded auth and no key was supplied. */
	| { status: "reachable" }
	/** Alive, but rejected the supplied key (401/403). */
	| { status: "auth" }
	/** Answered, but not like a gateway /v1/models listing. */
	| { status: "unexpected"; reason: string }
	| { status: "unreachable"; reason?: string };

/**
 * Cheap GET proving a candidate endpoint resolves and serves the key —
 * `GET {url}/models`. 200 + `{data:[…]}` ⇒ ok; 401/403 ⇒ alive but the key
 * is not accepted there (or missing); anything else is classified, never
 * thrown. Does not log the key.
 */
export async function probeBaseUrl(
	url: string,
	options: { apiKey?: string; fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<EndpointProbe> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? ENDPOINT_PROBE_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	try {
		const headers: Record<string, string> = {};
		if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
		const response = await (options.fetchImpl ?? fetch)(`${url}/models`, { headers, signal });
		if (response.status === 401 || response.status === 403) {
			return options.apiKey ? { status: "auth" } : { status: "reachable" };
		}
		if (!response.ok) return { status: "unexpected", reason: `HTTP ${response.status}` };
		const data = (await response.json().catch(() => null)) as { data?: unknown } | null;
		if (!data || !Array.isArray(data.data)) {
			return { status: "unexpected", reason: "response is not a /v1/models listing" };
		}
		return { status: "ok", models: data.data.length };
	} catch (error) {
		return { status: "unreachable", reason: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timeout);
	}
}

export function describeProbe(probe: EndpointProbe, url: string): { message: string; type: "info" | "warning" | "error" } {
	switch (probe.status) {
		case "ok":
			return { message: `${url} is LIVE — GET /models returned ${probe.models} models with the current key.`, type: "info" };
		case "reachable":
			return {
				message: `${url} is reachable but demands a key (401 before auth). No key resolved — set one to verify fully.`,
				type: "warning",
			};
		case "auth":
			return { message: `${url} is reachable but REJECTED the current key (401/403).`, type: "error" };
		case "unexpected":
			return { message: `${url} responded unexpectedly: ${probe.reason}.`, type: "warning" };
		case "unreachable":
			return { message: `${url} did not respond: ${probe.reason ?? "network error"}.`, type: "error" };
	}
}

export interface CustomEndpointOptions {
	fetchImpl?: typeof fetch;
	/** Persist + in-place rebind once the user accepts a candidate. */
	onPersist: (url: string) => void;
}

/**
 * Login-flow endpoint switcher ("start on the default, offer a custom one").
 * Prompts for a URL, probes it with the candidate key, and only persists +
 * rebinds after the probe passes or the user explicitly accepts the verdict.
 * Returns the new URL, or undefined to keep the current one. Cancel (Esc)
 * rejects the prompt per the pi auth contract, aborting login.
 */
export async function promptCustomEndpoint(
	interaction: ProviderAuthInteraction,
	currentUrl: string,
	apiKey: string | undefined,
	options: CustomEndpointOptions,
): Promise<string | undefined> {
	const fetchImpl = options.fetchImpl ?? fetch;
	urlLoop: while (true) {
		const raw = (
			await interaction.prompt({
				type: "text",
				message: "Endpoint URL (https://<gateway-id>.apigateway-<region>.volceapi.com/v1) — empty to keep current",
				placeholder: currentUrl,
			})
		).trim();
		if (!raw) return undefined;
		const normalized = normalizeBaseUrl(raw);
		if (!normalized) {
			interaction.notify({ type: "info", message: `"${raw}" is not a valid http(s) URL — try again.` });
			continue urlLoop;
		}
		if (normalized === currentUrl) return undefined;
		interaction.notify({ type: "progress", message: `Probing ${normalized} …` });
		const probe = await probeBaseUrl(normalized, { apiKey, fetchImpl, signal: interaction.signal });
		if (probe.status === "ok") {
			options.onPersist(normalized);
			interaction.notify({
				type: "info",
				message: `Endpoint verified: GET /models → 200 (${probe.models} models).`,
			});
			return normalized;
		}
		const described = describeProbe(probe, normalized);
		interaction.notify({ type: "info", message: described.message });
		const choice = await interaction.prompt({
			type: "select",
			message: "This endpoint is not verified. What next?",
			options: [
				{ id: "use", label: "Use it anyway", description: "Save and continue with this endpoint" },
				{ id: "another", label: "Enter a different URL…" },
				{ id: "keep", label: "Keep the current endpoint", description: currentUrl },
			],
		});
		if (choice === "use") {
			options.onPersist(normalized);
			return normalized;
		}
		if (choice === "keep") return undefined;
		// another → loop
	}
}

async function resolveKey(ctx: AuthContext, credential?: ApiKeyCredential) {
	const stored = credential?.key?.trim();
	if (stored) return { key: stored, source: "stored credential (Pi auth.json)" };
	const fromEnv = (await ctx.env(API_KEY_ENV))?.trim();
	if (fromEnv) return { key: fromEnv, source: `$${API_KEY_ENV}` };
	return undefined;
}

// ---------------------------------------------------------------------------
// provider factory
// ---------------------------------------------------------------------------

export interface VolcengineGatewayOptions {
	/** Static initial URL (tests); when omitted the factory resolves
	 *  env > settingsFile > default dynamically at every use. */
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	/** Settings file so the login flow can persist an endpoint switch. */
	settingsFile?: string;
	/** Called after login persists a new endpoint (entrypoint syncs its copy). */
	onEndpointSaved?: (settings: VolcengineSettings) => void;
}

export function createVolcengineGatewayProvider(options: VolcengineGatewayOptions = {}) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const settingsFile = options.settingsFile;
	let savedSettings: VolcengineSettings | undefined = settingsFile ? loadSettings(settingsFile) : undefined;
	/** Endpoint chosen during this process (login switch / url command) —
	 *  wins until restart, where env > settings > default applies again. */
	let sessionOverride: string | undefined;

	const currentBaseUrl = (): string =>
		sessionOverride ?? options.baseUrl ?? resolveBaseUrl(process.env, savedSettings);

	const provider = createProvider<GatewayApi>({
		id: PROVIDER_ID,
		name: "Volcengine API Gateway",
		baseUrl: currentBaseUrl(),
		auth: {
			apiKey: {
				name: "Volcengine Gateway API key",
				async login(interaction) {
					let url = currentBaseUrl();
					interaction.notify({
						type: "info",
						message: `Gateway endpoint: ${url} — use the consumer API key issued with your volceapi.com subscription (a plain Ark key will not work). Wrong endpoint? You can switch it below if the key is rejected.`,
					});
					const changeEndpoint = async (key: string): Promise<boolean> => {
						const next = await promptCustomEndpoint(interaction, url, key, {
							fetchImpl,
							onPersist: persistEndpoint,
						});
						if (!next) return false;
						if (process.env[BASE_URL_ENV]?.trim()) {
							interaction.notify({
								type: "info",
								message: `Note: $${BASE_URL_ENV} wins again on next start; the saved endpoint applies when the env is unset. This session already uses the new one.`,
							});
						}
						url = next;
						return true;
					};
					keyPrompt: while (true) {
						const key = (
							await interaction.prompt({
								type: "secret",
								message: "Volcengine Gateway API key (volceapi.com consumer key, UUID format)",
							})
						).trim();
						if (!key) continue keyPrompt;
						validateLoop: while (true) {
							interaction.notify({ type: "progress", message: `Validating key against ${url} …` });
							const result = await validateGatewayKey(key, { baseUrl: url, fetchImpl, signal: interaction.signal });
							if (result.status === "valid") {
								interaction.notify({ type: "info", message: "API key validated." });
								return { type: "api_key", key };
							}
							if (result.status === "invalid") {
								// 401 can mean "wrong key" OR "right key, wrong gateway": every
								// subscription has its own API Gateway URL.
								const choice = await interaction.prompt({
									type: "select",
									message:
										"The gateway rejected this key (401/403). A perfectly valid key is also rejected when the endpoint belongs to a different subscription — what next?",
									options: [
										{ id: "rekey", label: "Re-enter the API key", description: url },
										{
											id: "reurl",
											label: "Change the endpoint URL…",
											description: "Probed before saving; the key is then re-validated against it",
										},
									],
								});
								if (choice === "reurl" && (await changeEndpoint(key))) continue validateLoop;
								continue keyPrompt; // re-enter key (also when the URL change was declined)
							}
							const choice = await interaction.prompt({
								type: "select",
								message: `Gateway unreachable (${result.reason ?? "network error"}). What would you like to do?`,
								options: [
									{ id: "retry", label: "Retry validation" },
									{
										id: "reurl",
										label: "Change the endpoint URL…",
										description: "Maybe the default endpoint is not yours",
									},
									{ id: "save", label: "Save without validating" },
								],
							});
							if (choice === "save") return { type: "api_key", key };
							if (choice === "reurl" && (await changeEndpoint(key))) continue validateLoop;
							// retry: validate the same key against the same URL again
						}
					}
				},
				async check({ ctx, credential }) {
					const resolved = await resolveKey(ctx, credential);
					return resolved ? { type: "api_key", source: resolved.source } : undefined;
				},
				async resolve({ ctx, credential }) {
					const resolved = await resolveKey(ctx, credential);
					if (!resolved) return undefined;
					return { auth: { apiKey: resolved.key }, source: resolved.source };
				},
			},
		},
		models: buildModels(currentBaseUrl()),
		fetchModels: (context) => fetchGatewayModels(context, currentBaseUrl(), fetchImpl),
		api: {
			"openai-responses": openAIResponsesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});

	/**
	 * In-place rebind: pi's Models keeps the very object references returned
	 * by getModels() (no cloning/freezing — verified against pi-ai dist), so
	 * mutating baseUrl redirects subsequent requests without a /reload that
	 * the login interaction cannot trigger.
	 */
	function rebindBaseUrl(url: string): void {
		sessionOverride = url;
		(provider as { baseUrl?: string }).baseUrl = url;
		for (const model of provider.getModels()) (model as { baseUrl: string }).baseUrl = url;
	}

	/** Persist to the settings store, rebind live models, sync the entrypoint. */
	function persistEndpoint(url: string): void {
		rebindBaseUrl(url);
		if (settingsFile) {
			savedSettings = saveSettings({ baseUrl: url }, settingsFile);
			options.onEndpointSaved?.(savedSettings);
		}
	}

	return Object.assign(provider, { rebindBaseUrl, persistEndpoint });
}

// ---------------------------------------------------------------------------
// request payload fixes (before_provider_request)
// ---------------------------------------------------------------------------

/**
 * Returns a replacement payload, or undefined to keep the original.
 * 1. Responses payloads of STRIP_REASONING_SUMMARY models lose
 *    `reasoning.summary` (upstream 400s on the unknown field; effort and
 *    include are preserved).
 * 2. MiniMax-M3 chat payloads get `thinking.type:"enabled"` rewritten to
 *    "adaptive" (only adaptive|disabled are allowed upstream).
 */
export function rewriteProviderPayload(payload: unknown): unknown {
	if (!payload || typeof payload !== "object") return undefined;
	const p = payload as Record<string, unknown>;
	if (typeof p.model !== "string") return undefined;

	// Responses API shape (pi-ai always sends store:false + input).
	if (p.input !== undefined && p.store === false) {
		if (!STRIP_REASONING_SUMMARY.has(p.model)) return undefined;
		const reasoning = p.reasoning;
		if (!reasoning || typeof reasoning !== "object") return undefined;
		if (!("summary" in (reasoning as object))) return undefined;
		const { summary: _summary, ...effortOnly } = reasoning as Record<string, unknown>;
		return { ...p, reasoning: effortOnly };
	}

	// Chat completions shape.
	if (p.messages !== undefined && p.model === "MiniMax-M3") {
		const thinking = p.thinking as Record<string, unknown> | undefined;
		if (thinking && typeof thinking === "object" && thinking.type === "enabled") {
			return { ...p, thinking: { ...thinking, type: "adaptive" } };
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// context-overflow normalization (message_end)
// ---------------------------------------------------------------------------

const CONTEXT_OVERFLOW_RE =
	/OutofContextError|context_length_exceeded|exceed max message tokens|Total tokens of image and text exceed|Input tokens exceed|exceed(?:s|ed)?[^.\n]{0,60}context|Range of (?:input|prompt) length|上下文|超出限制|超过.*长度/i;
const RATE_LIMIT_RE = /rate.?limit|too many requests|requests per (?:second|minute)|\bquota\b|\b429\b/i;

/**
 * Maps gateway overflow errors onto pi's `context_length_exceeded` marker so
 * auto-compaction kicks in. Returns the rewritten message text, or null when
 * the error is not an overflow (rate limits must never trigger compaction).
 */
export function normalizeOverflowError(errorMessage: string): string | null {
	if (!errorMessage) return null;
	if (errorMessage.startsWith("context_length_exceeded")) return null; // idempotent
	if (RATE_LIMIT_RE.test(errorMessage)) return null;
	if (!CONTEXT_OVERFLOW_RE.test(errorMessage)) return null;
	return `context_length_exceeded: ${errorMessage}`;
}

// ---------------------------------------------------------------------------
// extension entry point (provider + hooks + /volcengine settings command)
// ---------------------------------------------------------------------------

type CompatFlags = { supportsLongCacheRetention?: boolean };

/** Routes that accepted `prompt_cache_retention:"24h"` (probe 2026-09-15). */
export const RETENTION_MODELS: ReadonlySet<string> = new Set(
	CATALOG.filter((m) => (m.compat as CompatFlags).supportsLongCacheRetention === true).map((m) => m.id),
);

/** Routes that reject the field with "json: unknown field" — never send it. */
export const NO_RETENTION_MODELS: ReadonlySet<string> = new Set(
	CATALOG.filter((m) => (m.compat as CompatFlags).supportsLongCacheRetention === false).map((m) => m.id),
);

const STATUS_KEY = "volcengine-gateway";

/** Structural subset of pi's ExtensionContext/ExtensionCommandContext — keeps
 *  this module testable with plain fakes (same seam style as pi-nvidia-plus). */
export interface VolcCtx {
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		select(title: string, options: string[]): Promise<string | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
	};
	model: { id: string; provider: string; api?: string } | undefined;
	signal: AbortSignal | undefined;
	modelRegistry: {
		getAll(): readonly { id: string; provider: string }[];
		getProviderAuthStatus(provider: string): { configured: boolean; source?: string; label?: string };
		getApiKeyForProvider(provider: string): Promise<string | undefined>;
		refresh(options?: {
			allowNetwork?: boolean;
			providers?: readonly string[];
			force?: boolean;
			signal?: AbortSignal;
		}): Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>;
	};
	sessionManager?: { getSessionId(): string };
}

export interface VolcengineExtensionOptions {
	/** Settings file override (tests); default ~/.pi/agent/volcengine-gateway.json. */
	settingsFile?: string;
	/** fetch override (tests) used by the key-check command. */
	fetchImpl?: typeof fetch;
}

export default function volcengineGateway(pi: ExtensionAPI, options: VolcengineExtensionOptions = {}): void {
	const settingsFile = options.settingsFile ?? settingsPath();
	const fetchImpl = options.fetchImpl ?? fetch;
	let settings: VolcengineSettings = loadSettings(settingsFile);

	function effectiveCacheRetention(): { mode: CacheRetentionMode; source: "env" | "settings" } {
		// PI_CACHE_RETENTION=long (pi-wide env) wins; the setting covers the
		// gateway models even when the env is not set.
		if (process.env.PI_CACHE_RETENTION?.trim().toLowerCase() === "long") return { mode: "long", source: "env" };
		return { mode: settings.cacheRetention, source: "settings" };
	}

	function endpoint(): { url: string; source: "env" | "settings" | "default" } {
		return { url: resolveBaseUrl(process.env, settings), source: baseUrlSource(process.env, settings) };
	}

	function updateStatusWidget(ctx: VolcCtx): void {
		if (!ctx.hasUI) return;
		const model = ctx.model;
		if (!model || model.provider !== PROVIDER_ID) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const { mode } = effectiveCacheRetention();
		const note = mode === "long" && !RETENTION_MODELS.has(model.id) ? " (n/a)" : "";
		ctx.ui.setStatus(STATUS_KEY, `volc:cache-${mode}${note}`);
	}

	const provider = createVolcengineGatewayProvider({
		fetchImpl,
		settingsFile,
		onEndpointSaved: (s) => {
			settings = s; // keep the entrypoint copy (status/widget/endpoint) in sync
		},
	});
	pi.registerProvider(provider);

	pi.on("before_provider_request", (event, ctx) => {
		let payload: unknown = event.payload;
		// 1) settings-driven 24h cache retention (no-op when pi already sent it)
		const retention = applyCacheRetention(payload, {
			enabled: effectiveCacheRetention().mode === "long",
			supportedModels: RETENTION_MODELS,
			sessionId: (ctx as VolcCtx)?.sessionManager?.getSessionId?.(),
		});
		if (retention !== undefined) payload = retention;
		// 2) per-model quirk fixes (reasoning.summary strip, MiniMax adaptive)
		const rewritten = rewriteProviderPayload(payload);
		if (rewritten !== undefined) payload = rewritten;
		return payload === event.payload ? undefined : (payload as typeof event.payload);
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (!message || message.role !== "assistant" || message.stopReason !== "error") return;
		if (message.provider !== PROVIDER_ID && ctx?.model?.provider !== PROVIDER_ID) return;
		const rewritten = normalizeOverflowError(message.errorMessage ?? "");
		if (rewritten === null) return;
		return { message: { ...message, errorMessage: rewritten } };
	});

	pi.on("session_start", (_event, ctx) => updateStatusWidget(ctx as VolcCtx));
	pi.on("model_select", (_event, ctx) => updateStatusWidget(ctx as VolcCtx));
	pi.on("thinking_level_select", (_event, ctx) => updateStatusWidget(ctx as VolcCtx));

	// ── /volcengine subcommands ─────────────────────────────────────────────

	const cmdStatus = async (_args: string, ctx: VolcCtx): Promise<void> => {
		const auth = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID);
		const count = ctx.modelRegistry.getAll().filter((m) => m.provider === PROVIDER_ID).length;
		const { mode, source } = effectiveCacheRetention();
		const current = ctx.model
			? ctx.model.provider === PROVIDER_ID
				? `${ctx.model.id} (${ctx.model.api}${RETENTION_MODELS.has(ctx.model.id) ? "" : ", no 24h"})`
				: `${ctx.model.provider}/${ctx.model.id} (other provider)`
			: "none";
		ctx.ui.notify(
			[
				"volcengine-gateway",
				`base URL: ${endpoint().url} (${endpoint().source})`,
				auth.configured
					? `key: configured (${auth.source ?? "unknown source"})`
					: "key: MISSING — /login volcengine-gateway or $VOLCEAPI_API_KEY",
				`cache retention: ${mode} (${source === "env" ? "PI_CACHE_RETENTION=long" : settingsFile})`,
				`models: ${count}`,
				`current: ${current}`,
			].join("\n"),
			"info",
		);
	};

	const cmdCache = async (args: string, ctx: VolcCtx): Promise<void> => {
		const parsed = parseCacheArg(args);
		if (parsed === undefined) {
			ctx.ui.notify(`Unknown cache mode "${args.trim()}" — use: cache [on|off|status]`, "warning");
			return;
		}
		if (parsed === "status") {
			const { mode, source } = effectiveCacheRetention();
			ctx.ui.notify(
				[
					`cache retention: ${mode} (${source === "env" ? "PI_CACHE_RETENTION=long env" : `settings: ${settingsFile}`})`,
					`24h routes (${RETENTION_MODELS.size}): ${[...RETENTION_MODELS].join(", ")}`,
					`no 24h (${NO_RETENTION_MODELS.size}): ${[...NO_RETENTION_MODELS].join(", ")} — gateway rejects the field`,
				].join("\n"),
				"info",
			);
			return;
		}
		settings = saveSettings({ cacheRetention: parsed }, settingsFile);
		const envLong = process.env.PI_CACHE_RETENTION?.trim().toLowerCase() === "long";
		const note = parsed === "short" && envLong ? " — note: PI_CACHE_RETENTION=long env still forces 24h" : "";
		ctx.ui.notify(
			`${parsed === "long" ? "24h cache retention enabled" : "Cache retention back to pi defaults"} (saved to ${settingsFile})${note}`,
			"info",
		);
		updateStatusWidget(ctx);
	};

	const cmdKeys = async (args: string, ctx: VolcCtx): Promise<void> => {
		const sub = args.trim().toLowerCase();
		if (sub !== "check") {
			ctx.ui.notify(
				sub ? `Unknown keys subcommand "${sub}" — use: keys check` : "Usage: keys check — validate the resolved gateway key",
				"warning",
			);
			return;
		}
		const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
		if (!key) {
			ctx.ui.notify("No API key resolved — run /login volcengine-gateway or set $VOLCEAPI_API_KEY", "warning");
			return;
		}
		ctx.ui.notify("Checking key against the gateway (zero-inference probe)…", "info");
		const result = await validateGatewayKey(key, { baseUrl: endpoint().url, fetchImpl, signal: ctx.signal });
		if (result.status === "valid") {
			ctx.ui.notify("Gateway key is VALID (authenticated; 400 model-field probe).", "info");
		} else if (result.status === "invalid") {
			ctx.ui.notify("Gateway REJECTED the key (401/403) — re-run /login volcengine-gateway.", "error");
		} else {
			ctx.ui.notify(`Gateway unreachable (${result.reason ?? "network error"}) — key validity unknown.`, "warning");
		}
	};

	const cmdModels = async (args: string, ctx: VolcCtx): Promise<void> => {
		const sub = args.trim().toLowerCase();
		if (sub !== "refresh") {
			ctx.ui.notify(
				sub
					? `Unknown models subcommand "${sub}" — use: models refresh`
					: "Usage: models refresh — re-pull GET /v1/models and persist the overlay",
				"warning",
			);
			return;
		}
		ctx.ui.notify("Refreshing catalog from GET /v1/models…", "info");
		const result = await ctx.modelRegistry.refresh({
			allowNetwork: true,
			providers: [PROVIDER_ID],
			force: true,
			signal: ctx.signal,
		});
		const error = result.errors.get(PROVIDER_ID);
		const count = ctx.modelRegistry.getAll().filter((m) => m.provider === PROVIDER_ID).length;
		if (error) {
			ctx.ui.notify(`Catalog refresh failed (${error.message}) — kept previous catalog (${count} models).`, "warning");
		} else {
			ctx.ui.notify(`Catalog refreshed: ${count} models registered for ${PROVIDER_ID}.`, "info");
		}
	};

	const cmdUrl = async (args: string, ctx: VolcCtx): Promise<void> => {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		const sub = (parts[0] ?? "status").toLowerCase();
		const value = parts.slice(1).join(" ");

		if (sub === "status") {
			const ep = endpoint();
			ctx.ui.notify(
				[
					`endpoint: ${ep.url}`,
					`source: ${ep.source}${ep.source === "env" ? ` ($${BASE_URL_ENV})` : ep.source === "settings" ? ` (${settingsFile})` : " (built-in)"}`,
					settings.baseUrl && ep.source === "env" ? `saved override (shadowed by env): ${settings.baseUrl}` : "",
					`default: ${DEFAULT_BASE_URL}`,
					"probe with: /volcengine url check [https://…]",
				]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
			return;
		}

		if (sub === "reset") {
			if (!settings.baseUrl) {
				ctx.ui.notify(`No saved endpoint override — already using ${endpoint().url} (${endpoint().source}).`, "info");
				return;
			}
			settings = saveSettings({ baseUrl: null }, settingsFile);
			provider.rebindBaseUrl(endpoint().url);
			const ep = endpoint();
			ctx.ui.notify(`Override cleared — now using ${ep.url} (${ep.source}), bound in-place.`, "info");
			return;
		}

		if (sub !== "set" && sub !== "check") {
			ctx.ui.notify(
				sub === "url" || !sub
					? "Usage: url [status|set <https://…>|check <https://…>|reset]"
					: `Unknown url subcommand "${sub}" — use: status, set, check, reset`,
				"warning",
			);
			return;
		}

		let candidate = value;
		if (!candidate) {
			if (sub === "check") {
				candidate = endpoint().url; // bare `url check` probes the effective endpoint
			} else if (!ctx.hasUI) {
				ctx.ui.notify("Usage: url set <https://…> (interactive prompt needs the TUI)", "warning");
				return;
			} else {
				candidate = (await ctx.ui.input("Volcengine gateway base URL:", endpoint().url)) ?? "";
			}
		}
		const normalized = normalizeBaseUrl(candidate);
		if (!normalized) {
			ctx.ui.notify(
				`Invalid endpoint URL ${JSON.stringify(candidate.trim())} — expected https://… (e.g. https://<id>.apigateway-cn-beijing.volceapi.com/v1)`,
				"warning",
			);
			return;
		}
		if (sub === "set" && normalized === endpoint().url && endpoint().source !== "settings") {
			// Same URL the env/default already provides: nothing to persist.
			ctx.ui.notify(`${normalized} is already the effective endpoint (${endpoint().source}) — nothing to save.`, "info");
			return;
		}

		// Detection: probe the candidate with the resolved key before switching.
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
		ctx.ui.notify(`Probing ${normalized} …`, "info");
		const probe = await probeBaseUrl(normalized, { apiKey, fetchImpl, signal: ctx.signal });

		if (sub === "check") {
			const described = describeProbe(probe, normalized);
			ctx.ui.notify(described.message, described.type);
			return;
		}

		if (probe.status === "ok") {
			provider.persistEndpoint(normalized);
			ctx.ui.notify(`Endpoint verified (GET /models → 200, ${probe.models} models), saved to ${settingsFile} and bound in-place.`, "info");
			noteEnvShadow(ctx);
			return;
		}

		const described = describeProbe(probe, normalized);
		const question = `${described.message} Save it anyway?`;
		if (!ctx.hasUI) {
			ctx.ui.notify(`${question} (answer in the TUI, or export ${BASE_URL_ENV}=${normalized})`, described.type);
			return;
		}
		const save = await ctx.ui.confirm("Unverified endpoint", question);
		if (!save) {
			ctx.ui.notify("Endpoint NOT saved — keeping " + endpoint().url, "info");
			return;
		}
		provider.persistEndpoint(normalized);
		ctx.ui.notify(`Saved WITHOUT verification and bound in-place.`, "warning");
		noteEnvShadow(ctx);
	};

	function noteEnvShadow(ctx: VolcCtx): void {
		if (process.env[BASE_URL_ENV]?.trim()) {
			ctx.ui.notify(
				`Note: $${BASE_URL_ENV} env override wins again on next start; the saved endpoint applies when the env is unset. This session already uses the saved one.`,
				"warning",
			);
		}
	}

	const runners: Record<string, (args: string, ctx: VolcCtx) => Promise<void>> = {
		status: cmdStatus,
		cache: cmdCache,
		url: cmdUrl,
		keys: cmdKeys,
		models: cmdModels,
	};

	pi.registerCommand("volcengine", {
		description: "Volcengine gateway settings: status, cache retention, endpoint URL, key check, catalog refresh",
		getArgumentCompletions: (prefix: string) => completeArgs(prefix, volcengineCommands()),
		handler: async (args: string, ctx: VolcCtx) => {
			const trimmed = (args ?? "").trim();
			const [sub, ...rest] = trimmed.split(/\s+/).filter(Boolean);
			const run = sub ? runners[sub] : undefined;
			if (!run) {
				const list = volcengineCommands().map(formatCommandLine).join("\n");
				ctx.ui.notify(sub ? `Unknown command "${sub}".\n/volcengine:\n${list}` : `/volcengine:\n${list}`, "info");
				return;
			}
			await run(rest.join(" "), ctx);
		},
	});
}
