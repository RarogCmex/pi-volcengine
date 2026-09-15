/**
 * Volcengine API Gateway (volceapi.com) provider for the pi coding agent.
 *
 * Endpoint: per-subscriber API Gateway URL, e.g.
 *           https://<id>.apigateway-cn-beijing.volceapi.com/v1
 *           (override with $VOLCEAPI_BASE_URL)
 * Auth:     API key via $VOLCEAPI_API_KEY or `pi /login volcengine-gateway`
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
 * Context windows / max output tokens: from gateway 400-error caps where
 * available (kimi 262144/1048576, MiniMax 524288, zhipu 131072, hy3 input
 * 192000, deepseek-v4-flash 393216, doubao 262144, glm 131072, qwen3.7
 * 131072), otherwise from the official Ark routes of the reference extensions.
 *
 * Billing: the gateway reports a per-model `credit` multiplier via
 * GET /v1/models (changes over time — credit_history). 1 credit ≈ $1 per 1M
 * tokens (scale-matched against public Ark pricing); costs below use the
 * credits observed on 2026-09-15 and are refreshed by `pi update --models`
 * (refreshModels fetches /v1/models, persists to pi's models store, and
 * auto-registers newly added gateway models with conservative defaults).
 *
 * Usage:
 *   export VOLCEAPI_API_KEY=...
 *   pi                      # /model -> volcengine-gateway/<model>
 *   pi update --models      # refresh catalog/credits from the gateway
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ID = "volcengine-gateway";
export const DEFAULT_BASE_URL = "https://YOUR-GATEWAY-ID.apigateway-cn-beijing.volceapi.com/v1";
export const API_KEY_ENV = "VOLCEAPI_API_KEY";
export const BASE_URL_ENV = "VOLCEAPI_BASE_URL";

/** How long a persisted gateway catalog stays fresh before a network refresh. */
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Timeout for the GET /models catalog fetch. */
const FETCH_TIMEOUT_MS = 10_000;

export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[BASE_URL_ENV]?.trim();
	if (override) return override.replace(/\/+$/, "");
	return DEFAULT_BASE_URL;
}

// ---------------------------------------------------------------------------
// compat blocks (pi's extension form does NOT merge provider-level compat —
// every field lives per model, so shared sets are spread into each entry)
// ---------------------------------------------------------------------------

/** Verified on every /responses route: developer role OK, strict tools not needed.
 *  supportsLongCacheRetention:false keeps pi from sending the unverified
 *  `prompt_cache_retention` field. */
const RESPONSES_COMPAT = {
	supportsDeveloperRole: true,
	supportsLongCacheRetention: false,
	supportsStrictMode: false,
} satisfies Partial<ProviderModelConfig["compat"]>;

/** Verified on every /chat/completions route: system role, no `store`,
 *  usage-in-streaming via stream_options, max_completion_tokens accepted. */
const CHAT_COMPAT = {
	supportsDeveloperRole: false,
	supportsStore: false,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens" as const,
} satisfies Partial<ProviderModelConfig["compat"]>;

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
} as const;

/** doubao-seed-2.1-pro: none/minimal/low/medium/high verified; none ⇒ rt=0. */
const DOUBAO_EFFORT = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
	max: "high",
} as const;

/** glm-5.2: every value verified incl. max; none/minimal ⇒ rt=0. */
const GLM52_EFFORT = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "max",
	max: "max",
} as const;

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
} as const;

/** qwen3.7/3.8: none/minimal/low/medium/high/max verified (none ⇒ rt=0). */
const QWEN_EFFORT = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "max",
	max: "max",
} as const;

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
} as const;

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
} as const;

/** Models whose upstream rejects `reasoning.summary` on /responses — the
 *  before_provider_request hook strips it from their payloads. */
export const STRIP_REASONING_SUMMARY = new Set(["deepseek-v4-flash", "doubao-seed-2.1-pro", "glm-5.2"]);

/** Gateway smart-routing pseudo-entry that must never be registered. */
const SKIP_MODEL_IDS = new Set(["auto"]);

/** Credits observed via GET /v1/models on 2026-09-15 (≈ $/1M tokens). */
function credits(credit: number): ProviderModelConfig["cost"] {
	return { input: credit, output: credit, cacheRead: 0, cacheWrite: 0 };
}

// ---------------------------------------------------------------------------
// static catalog (verified against the live gateway on 2026-09-15)
// ---------------------------------------------------------------------------

export const CATALOG: ProviderModelConfig[] = [
	// ---- Responses API (provider default api) ----
	{
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		reasoning: true,
		thinkingLevelMap: { ...DEEPSEEK_EFFORT },
		input: ["text"],
		cost: credits(0.33),
		contextWindow: 1_000_000,
		maxTokens: 393_216, // gateway cap: "max_output_tokens <= 393216"
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
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
		reasoning: true,
		thinkingLevelMap: { ...DOUBAO_EFFORT },
		input: ["text", "image"], // vision verified
		cost: credits(1.85),
		contextWindow: 256_000, // >256k input rejected ("exceed max message tokens")
		maxTokens: 262_144, // gateway cap
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "glm-5.2",
		name: "GLM 5.2",
		reasoning: true,
		thinkingLevelMap: { ...GLM52_EFFORT },
		input: ["text"], // image input yields empty output on this route
		cost: credits(1.46),
		contextWindow: 1_000_000,
		maxTokens: 131_072, // gateway cap
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "glm-5.3",
		name: "GLM 5.3",
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

// ---------------------------------------------------------------------------
// dynamic catalog (GET /v1/models) merged over the static capability table
// ---------------------------------------------------------------------------

export interface GatewayModelEntry {
	id?: unknown;
	name?: unknown;
	credit?: unknown;
}

/** Conservative registration for gateway models this build has never seen. */
export function unknownModelConfig(id: string, name?: string, credit?: number): ProviderModelConfig {
	return {
		id,
		name: name?.trim() || id,
		api: "openai-completions", // chat completions works for every gateway model
		reasoning: true,
		// every level null => pi sends no thinking parameters at all
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
		input: ["text"],
		cost: credit !== undefined && credit > 0 ? credits(credit) : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
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
export function mergeGatewayCatalog(raw: GatewayModelEntry[]): ProviderModelConfig[] {
	const known = new Map(CATALOG.map((entry) => [entry.id, entry]));
	const merged: ProviderModelConfig[] = [];
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
			});
		} else {
			merged.push(unknownModelConfig(id, name, credit));
		}
	}
	if (merged.length === 0) return CATALOG.map((entry) => ({ ...entry }));
	return merged;
}

/** Structural mirror of pi-ai's RefreshModelsContext (avoids a hard pi-ai dep). */
export interface GatewayRefreshContext {
	credential?: { type?: string; key?: string } | undefined;
	stored?: { models?: unknown[]; checkedAt?: number } | undefined;
	publish(publication: { persist?: unknown; update?: () => void }): Promise<boolean>;
	allowNetwork: boolean;
	force?: boolean | undefined;
	signal: AbortSignal;
}

function staticCatalog(): ProviderModelConfig[] {
	return CATALOG.map((entry) => ({ ...entry }));
}

function storedCatalog(ctx: GatewayRefreshContext): ProviderModelConfig[] {
	const models = ctx.stored?.models;
	if (!Array.isArray(models) || models.length === 0) return staticCatalog();
	const filtered = models.filter((m) => {
		const provider = (m as { provider?: unknown })?.provider;
		return provider === undefined || provider === PROVIDER_ID;
	}) as ProviderModelConfig[];
	return filtered.length > 0 ? filtered : staticCatalog();
}

/**
 * pi-native dynamic refresh: offline runs restore the persisted catalog;
 * network runs (pi update --models, background refresh) re-fetch
 * GET /v1/models at most every REFRESH_INTERVAL_MS unless forced.
 */
export async function refreshGatewayModels(
	ctx: GatewayRefreshContext,
	env: NodeJS.ProcessEnv = process.env,
	fetchImpl: typeof fetch = fetch,
): Promise<ProviderModelConfig[]> {
	const cached = storedCatalog(ctx);
	if (!ctx.allowNetwork) return cached;

	const key = ctx.credential?.type === "api_key" ? ctx.credential.key : undefined;
	if (!key) return cached;

	const checkedAt = ctx.stored?.checkedAt;
	if (!ctx.force && checkedAt !== undefined && Date.now() - checkedAt < REFRESH_INTERVAL_MS) {
		return cached;
	}

	try {
		const baseUrl = resolveBaseUrl(env);
		const response = await fetchImpl(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
		});
		if (!response.ok) return cached;
		const data = (await response.json()) as { data?: GatewayModelEntry[] };
		if (!Array.isArray(data?.data) || data.data.length === 0) return cached;
		const merged = mergeGatewayCatalog(data.data);
		const persisted = merged.map((model) => ({ ...model, provider: PROVIDER_ID, baseUrl }));
		await ctx.publish({ persist: { models: persisted, checkedAt: Date.now() } });
		if (ctx.signal.aborted) return cached;
		return merged;
	} catch {
		return cached;
	}
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
// extension entry point
// ---------------------------------------------------------------------------

export default function volcengineGateway(pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, {
		name: "Volcengine API Gateway",
		baseUrl: resolveBaseUrl(),
		apiKey: `$${API_KEY_ENV}`,
		api: "openai-responses",
		models: staticCatalog(),
		refreshModels: (ctx) => refreshGatewayModels(ctx as unknown as GatewayRefreshContext),
	});

	pi.on("before_provider_request", (event) => {
		const rewritten = rewriteProviderPayload(event.payload);
		return rewritten === undefined ? undefined : (rewritten as typeof event.payload);
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (!message || message.role !== "assistant" || message.stopReason !== "error") return;
		if (message.provider !== PROVIDER_ID && ctx?.model?.provider !== PROVIDER_ID) return;
		const rewritten = normalizeOverflowError(message.errorMessage ?? "");
		if (rewritten === null) return;
		return { message: { ...message, errorMessage: rewritten } };
	});
}
