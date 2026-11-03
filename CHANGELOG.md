# Changelog

Entries are read by pi 1.5.0 and shown under "Extension Updates" on the first fresh
launch after the package version grows. Headings must stay in the `## [x.y.z]` form —
pi's parser (`dist/utils/changelog.js`) only recognises a version triple.

## [0.1.3] — 2026-11-03

**Re-verified against pi 1.5.0** (2026-11-03): `npm install` moved the pinned host
to `pi-coding-agent` 1.5.0 / `pi-ai` 1.5.0, `tsc -p tsconfig.json` clean,
**80/80** tests green, offline boot unchanged. This release carries no
provider-behaviour change: it is the 1.5.0 host migration plus the first
`CHANGELOG.md` (`pi.changelogPath` is not set — the file is at the package root).

- **Adopted — the package changelog.** pi 1.5.0 reads `<package>/CHANGELOG.md`
  and shows entries newer than the version it last saw on the first fresh launch;
  a git package only moves when `version` grows, hence the patch bump.
- **Not adopted from 1.5.0, deliberately.** This package registers no tools, so
  the pi-schema validation/coercion contract does not apply; there is no custom
  tool renderer (`keyHint()`/`keyText()`), no `ctx.ui.custom()` (`blocked`), and
  `pi.exec()` is never called (`maxBuffer`/`truncated`). `Usage.cost.totalFromProvider`
  and `responseModel` are filled by the host runtime. GPT-6.1 Terra, models.dev v2
  and the changed defaults are host catalogs; this package's cards come from its
  own verified catalog and the live `/v1/models` overlay. MCP OAuth client
  registration does not apply.
- **No code break this time.** pi-ai 1.5.0 stopped re-exporting TypeBox, but this
  package never imported `Type` — grep over `index.ts`, `settings.ts` and `test/`
  finds no TypeBox builder use — so the offline suite went green unchanged.

## [0.1.2] — 2026-10-22

Re-pinned the host to pi 1.4.0 (`@earendil-works/pi-ai` and
`@earendil-works/pi-coding-agent` dev deps): typecheck + 80/80 offline tests green,
and `pi -ne -e <repo> --offline --list-models volcengine-gateway` printed the same
15 models. No provider-surface change.

## [0.1.1] — 2026-10-06

Re-pinned the host to pi 1.0.4 (dev deps; was 1.0.0). Typecheck + 80/80 offline
tests green; offline `--list-models` unchanged.

## [0.1.0] — 2026-09-15

Initial release: the Volcengine API Gateway provider, Responses API first with a
chat-completions fallback; a native `createProvider` form with a validated
`/login` flow; `prompt_cache_retention` support verified per route; the
`/volcengine` command for in-pi settings; endpoint URL override with probe
detection and login-time endpoint switching. The same round removed the private
gateway id and key prefix in favour of a placeholder endpoint, made the config
dir portable with platform-aware env hints, and added the public docs, AGENTS.md
and the pinned-host/latest-host CI suites. The host pin moved to pi 1.0.0 on
2026-10-03 while the package version stayed 0.1.0.
