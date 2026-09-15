/**
 * In-pi settings for the Volcengine gateway provider.
 *
 * Pattern follows pi-nvidia-plus: a small JSON store under ~/.pi/agent,
 * a single `/volcengine` slash command with a subcommand tree + pure
 * autocomplete, and pure payload helpers that index.ts wires into
 * `before_provider_request`.
 *
 * Store file: ~/.pi/agent/volcengine-gateway.json
 *   { "version": 1, "cacheRetention": "long" | "short", "updatedAt": "..." }
 *
 * `cacheRetention: "long"` makes the payload hook inject
 * `prompt_cache_retention: "24h"` (+ `prompt_cache_key` on chat routes) for
 * gateway models verified to accept it — without requiring the global
 * PI_CACHE_RETENTION=long env var. If pi already sent the field (env long),
 * the hook is a no-op.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// settings store
// ---------------------------------------------------------------------------

export type CacheRetentionMode = "long" | "short";

export interface VolcengineSettings {
	version: 1;
	cacheRetention: CacheRetentionMode;
	updatedAt?: string;
}

export const SETTINGS_FILE_NAME = "volcengine-gateway.json";
export const DEFAULT_SETTINGS: VolcengineSettings = { version: 1, cacheRetention: "short" };

export function settingsPath(baseDir: string = join(homedir(), ".pi", "agent")): string {
	return join(baseDir, SETTINGS_FILE_NAME);
}

/** Missing/corrupt/foreign-version files degrade to defaults — a broken
 *  settings file must never break pi startup. */
export function loadSettings(file: string = settingsPath()): VolcengineSettings {
	try {
		if (!existsSync(file)) return { ...DEFAULT_SETTINGS };
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<VolcengineSettings> | null;
		if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return { ...DEFAULT_SETTINGS };
		return {
			version: 1,
			cacheRetention: parsed.cacheRetention === "long" ? "long" : "short",
			...(typeof parsed.updatedAt === "string" ? { updatedAt: parsed.updatedAt } : {}),
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveSettings(
	patch: { cacheRetention?: CacheRetentionMode },
	file: string = settingsPath(),
): VolcengineSettings {
	const current = loadSettings(file);
	const next: VolcengineSettings = {
		version: 1,
		cacheRetention: patch.cacheRetention ?? current.cacheRetention,
		updatedAt: new Date().toISOString(),
	};
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return next;
}

/** `cache` subcommand argument parsing: on/long/24h → long, off/short → short. */
export function parseCacheArg(arg: string | undefined): CacheRetentionMode | "status" | undefined {
	const value = (arg ?? "").trim().toLowerCase();
	if (value === "" || value === "status") return "status";
	if (["on", "long", "24h", "enable", "enabled", "true"].includes(value)) return "long";
	if (["off", "short", "default", "disable", "disabled", "false"].includes(value)) return "short";
	return undefined;
}

// ---------------------------------------------------------------------------
// cache-retention payload injection (pure)
// ---------------------------------------------------------------------------

/** OpenAI-family prompt_cache_key length cap (pi-ai clamps the same way). */
export const MAX_CACHE_KEY_LENGTH = 64;

export function clampCacheKey(value: string): string {
	return value.length > MAX_CACHE_KEY_LENGTH ? value.slice(0, MAX_CACHE_KEY_LENGTH) : value;
}

export interface CacheRetentionOptions {
	/** Effective long-retention preference (settings or PI_CACHE_RETENTION=long). */
	enabled: boolean;
	/** Model ids whose routes accepted prompt_cache_retention (probe 2026-09-15). */
	supportedModels: ReadonlySet<string>;
	/** pi session id — becomes prompt_cache_key on chat routes (pi only sends
	 *  it there under its own long mode). */
	sessionId?: string;
}

/**
 * Adds `prompt_cache_retention:"24h"` to a gateway payload when the setting
 * is on, the model is verified, and pi has not already sent the field.
 * Chat payloads also gain `prompt_cache_key` (clamped session id) because
 * pi-ai omits it there outside its own long mode.
 * Returns the replacement payload, or undefined to keep the original.
 */
export function applyCacheRetention(payload: unknown, options: CacheRetentionOptions): unknown {
	if (!options.enabled) return undefined;
	if (!payload || typeof payload !== "object") return undefined;
	const p = payload as Record<string, unknown>;
	if (typeof p.model !== "string" || !options.supportedModels.has(p.model)) return undefined;
	if (p.prompt_cache_retention !== undefined) return undefined; // pi already sent it
	const isResponses = p.input !== undefined && p.store === false;
	const isChat = p.messages !== undefined;
	if (!isResponses && !isChat) return undefined;
	const next: Record<string, unknown> = { ...p, prompt_cache_retention: "24h" };
	if (isChat && next.prompt_cache_key === undefined && options.sessionId) {
		next.prompt_cache_key = clampCacheKey(options.sessionId);
	}
	return next;
}

// ---------------------------------------------------------------------------
// /volcengine command catalog + autocomplete
// ---------------------------------------------------------------------------

export interface CommandArg {
	name: string;
	description: string;
}

export interface CommandSpec {
	name: string;
	description: string;
	args?: readonly CommandArg[];
}

export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

export function volcengineCommands(): CommandSpec[] {
	return [
		{
			name: "status",
			description: "Base URL, key source, cache mode, catalog size, current model",
		},
		{
			name: "cache",
			description: "24h prompt-cache retention for verified routes (persisted)",
			args: [
				{ name: "on", description: "Inject prompt_cache_retention:24h on supported models" },
				{ name: "off", description: "Only pi's default caching (PI_CACHE_RETENTION still applies)" },
				{ name: "status", description: "Show current cache mode and supported routes" },
			],
		},
		{
			name: "keys",
			description: "Gateway API key tools",
			args: [{ name: "check", description: "Validate the resolved key against the gateway (zero inference)" }],
		},
		{
			name: "models",
			description: "Model catalog tools",
			args: [{ name: "refresh", description: "Force GET /v1/models refresh and persist the overlay" }],
		},
	];
}

function item(value: string, label: string, description: string): CompletionItem {
	return { value, label, description };
}

/** `cache [on|off|status]` */
export function argsHint(command: CommandSpec): string {
	if (!command.args?.length) return "";
	return ` [${command.args.map((a) => a.name).join("|")}]`;
}

/** `cache [on|off|status] — …` for usage lines. */
export function formatCommandLine(command: CommandSpec): string {
	return `${command.name}${argsHint(command)} — ${command.description}`;
}

/**
 * Argument autocomplete for `/volcengine` (TUI CombinedAutocompleteProvider
 * contract: `prefix` is the text after the command name, a chosen `value`
 * replaces it whole — hence nested values are `"cache on"`, not `"on"`).
 */
export function completeArgs(prefix: string, commands: readonly CommandSpec[]): CompletionItem[] | null {
	const text = prefix.trimStart();
	const space = text.indexOf(" ");
	if (space === -1) {
		if (text.length > 0) {
			const exact = commands.find((c) => c.name === text);
			if (exact?.args?.length) {
				const nested = exact.args.map((a) => item(`${exact.name} ${a.name}`, a.name, a.description));
				return nested.length > 0 ? nested : null;
			}
		}
		const items = commands
			.filter((c) => c.name.startsWith(text))
			.map((c) => item(`${c.name} `, `${c.name}${argsHint(c)}`, c.description));
		return items.length > 0 ? items : null;
	}

	const name = text.slice(0, space);
	const rest = text.slice(space).trimStart();
	if (rest.includes(" ")) return null;

	const command = commands.find((c) => c.name === name);
	if (!command?.args?.length) return null;

	const items = command.args
		.filter((a) => a.name.startsWith(rest))
		.map((a) => item(`${name} ${a.name}`, a.name, a.description));
	return items.length > 0 ? items : null;
}
