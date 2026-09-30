# pi-volcengine

Расширение-провайдер для [pi coding agent](https://github.com/earendil-works/pi), подключающее подписку **Volcengine API Gateway** (`*.apigateway-cn-beijing.volceapi.com`). npm-имя пакета — `@rarogcmex/pi-volcengine`.

> **In English.** pi-volcengine registers a **Volcengine API Gateway**
> subscription (`*.apigateway-cn-beijing.volceapi.com`) as a native pi provider
> under the id `volcengine-gateway`. The preferred wire protocol is the OpenAI
> **Responses API** (`store:false`, streaming, tool calling, reasoning replays);
> models whose upstreams do not serve Responses on this gateway fall back to Chat
> Completions. Install with
> `pi install git:github.com/RarogCmex/pi-volcengine@main`, then set your
> per-subscription endpoint (`$VOLCEAPI_BASE_URL` or `/volcengine url set …`) and
> authenticate with `/login volcengine-gateway`. Every model parameter — effort
> values, token limits, vision, thinking format — was verified against the live
> gateway on 2026-09-15. The rest of this README is in Russian; code comments and
> the npm metadata are in English.

Приоритетный протокол — **OpenAI Responses API** (`/v1/responses`, stateless `store:false`, стриминг, tool calling, reasoning-реплеи). Модели, чьи апстримы не поддерживают Responses на этом шлюзе, работают через **Chat Completions** (`/v1/chat/completions`).

Все параметры моделей (effort-значения, лимиты токенов, vision, формат thinking) **проверены живыми запросами к шлюзу 2026-09-15**.

## Установка

```bash
pi install git:github.com/RarogCmex/pi-volcengine@main
# или локально
pi install /path/to/pi-volcengine
```

Расширение состоит из двух файлов (`index.ts` импортирует `./settings.ts`) — копируйте пакет целиком, отдельный `index.ts` в `~/.pi/agent/extensions/` работать не будет.

## Авторизация

**Вариант 1 — интерактивный (рекомендуется):**

```
/login volcengine-gateway
```

Расширение попросит consumer-ключ шлюза (UUID) и **проверит его до сохранения** zero-inference зондом (`POST {} → /responses`: 400 = ключ прошёл аутентификацию, 401 = отклонён). Ключ ляжет в `~/.pi/agent/auth.json`.

**Смена Endpoint URL прямо во время login** (у каждой подписки свой gateway-id; если endpoint ещё не задан, login стартует на плейсхолдере и сразу предупреждает об этом, а валидный ключ чужой подписки на вашем шлюзе даст 401):

- **401/403** → выбор: «Re-enter the API key» / «Change the endpoint URL…»;
- **шлюз недоступен** → «Retry validation» / «Change the endpoint URL…» / «Save without validating»;
- в ветке смены URL: ввод `https://<gateway-id>.apigateway-<region>.volceapi.com/v1` → проба `GET /models` введённым ключом → 200 сохраняется молча; иначе выбор «Use it anyway / Enter a different URL… / Keep current»; пустой ввод = остаться на текущем; Esc = отмена login;
- принятый URL пишется в `~/.pi/agent/volcengine-gateway.json`, провайдер и все модели **перепривязываются in-place** (pi хранит те же ссылки на объекты моделей — `/reload` не нужен), и ключ тут же переоверяется против нового шлюза.

Обнаружить чужой gateway-id автоматически нельзя — Volcengine не публикует discovery-API для подписчиков, поэтому детект здесь = валидация кандидата пробой, а не поиск.

**Вариант 2 — переменная окружения:**

```bash
export VOLCEAPI_API_KEY="<ваш-consumer-key-UUID>"
```

PowerShell (Windows): `$env:VOLCEAPI_API_KEY="<ваш-consumer-key-UUID>"`.

Сохранённый через `/login` ключ имеет приоритет над env. Порядок разрешения: stored credential → `$VOLCEAPI_API_KEY`.

**Base URL обязателен к настройке**: у каждой подписки volceapi.com свой gateway-id, поэтому в расширение зашит плейсхолдер (`https://YOUR-GATEWAY-ID.apigateway-cn-beijing.volceapi.com/v1`), а не рабочий хост. Укажите свой endpoint одним из способов:

```bash
export VOLCEAPI_BASE_URL="https://<ваш-id>.apigateway-cn-beijing.volceapi.com/v1"
```

PowerShell (Windows): `$env:VOLCEAPI_BASE_URL="https://<ваш-id>.apigateway-cn-beijing.volceapi.com/v1"`. Конфиг pi берётся из `$PI_CODING_AGENT_DIR` (по умолчанию `~/.pi/agent`), файл настроек — `<agentDir>/volcengine-gateway.json`.

или внутри pi: `/volcengine url set https://<ваш-id>.apigateway-cn-beijing.volceapi.com/v1` (кандидат сначала пробуется `GET /models`). Пока endpoint не задан, `/volcengine status` показывает предупреждение, а `/login` сразу предлагает ветку смены URL.

Выбор модели: `/model` → `volcengine-gateway/<id>`; список: `pi --list-models volcengine-gateway` (id провайдера — `volcengine-gateway`, не `volcengine`; показывается только при разрешённой авторизации).

## Настройки внутри pi — `/volcengine`

Одна команда с деревом подкоманд, автодополнение аргументов (Tab), персистентные настройки в `~/.pi/agent/volcengine-gateway.json` и виджет в status-баре.

| Команда | Действие |
|---|---|
| `/volcengine status` | Base URL (+ источник: env/settings/default), источник ключа (stored/env), режим кэша, размер каталога, текущая модель |
| `/volcengine cache on\|off\|status` | 24h prompt-cache retention без глобального `PI_CACHE_RETENTION=long`: хук инжектит `prompt_cache_retention:"24h"` (+ `prompt_cache_key` на chat-маршрутах) только в 12 проверенных маршрутов; 3 строгие модели не трогаются никогда. Настройка сохраняется в файл и подхватывается мгновенно |
| `/volcengine url status\|set\|check\|reset` | Оверрайд Endpoint URL: кандидат пробуется до сохранения, а не после. Приоритет: `$VOLCEAPI_BASE_URL` > сохранённый `baseUrl` > встроенный плейсхолдер (не рабочий хост — см. «Авторизация»). `set <https://…>` сначала делает пробу `GET /models` текущим ключом: 200+листинг → сохраняет без вопросов; 401/403 или недоступность → confirm «Save anyway?» (в headless-режиме не сохраняет вовсе). `check [url]` — проба без сохранения, `reset` — сброс оверрайда. Сохранение перепривязывает провайдер и модели in-place (pi хранит те же ссылки на объекты моделей — `/reload` не нужен) |
| `/volcengine keys check` | Валидация текущего ключа zero-inference зондом (400 = валиден, 401/403 = отклонён, сеть недоступна = статус неизвестен) |
| `/volcengine models refresh` | Принудительный `GET /v1/models` (force, provider-scoped) → слияние с каталогом → persist в `~/.pi/agent/models-store.json` |

Приоритет режима кэша: `PI_CACHE_RETENTION=long` (env) > настройка `/volcengine cache`. Если pi уже отправил `prompt_cache_retention` (env-режим), хук ничего не добавляет. Виджет в status-баре: `volc:cache-long` (+ `(n/a)`, если текущая модель не принимает 24h); обновляется на `session_start`, `model_select`, `thinking_level_select`.

Файл настроек: `~/.pi/agent/volcengine-gateway.json` — `{ version, cacheRetention, baseUrl?, updatedAt }`; битый/чужой файл безопасно деградирует в дефолты.

## Модели

`credit` — множитель тарификации шлюза из `GET /v1/models` (≈ $/1M токенов). Цены в pi отображаются приблизительно по этому множителю. Множитель **меняется со временем**: расширение читает из листинга только `id`, `name` и `credit` (`GatewayModelEntry` в `index.ts`) и при каждом обновлении каталога берёт свежее значение, но историю изменений шлюза не хранит и не показывает — точная бухгалтерия доступна только в панели Volcengine.

### Responses API (приоритет)

| Model ID | Контекст | Max output | Thinking-уровни | Vision | Credit |
|---|---|---|---|---|---|
| `deepseek-v4-flash` | 1M | 393 216 | off(none)…high (+xhigh/max→high) | — | 0.33 |
| `deepseek-v4-pro` | 1M | 393 216 | off(none)…high (+xhigh/max→high) | — | 0.99 |
| `doubao-seed-2.1-pro` | 256K | 262 144 | off(none)…high (+xhigh/max→high) | ✓ | 1.85 |
| `glm-5.2` | 1M | 131 072 | off(none)…high (+xhigh/max→max) | — | 1.46 |
| `glm-5.3` | 1M | 131 072 | low/high/max («всегда думает») | — | 1.95 |
| `glm-5.3-flash` | 1M | 131 072 | low/high/max («всегда думает») | ✓ | 0.22 |
| `qwen3.7-max` | 800K* | 131 072 | off(none)…max | — | 2.64 |
| `qwen3.7-plus` | 800K* | 131 072 | off(none)…max | ✓ | 0.59 |
| `qwen3.8-flash` | 800K* | 131 072 | off(none)…max | ✓ | 0.19 |
| `qwen3.8-max` | 800K* | 131 072 | off(none)…max | ✓ | 2.84 |

\* Шлюз обрезает вход qwen на 800K токенов (проверено: входы 1.05M и 1.2M дают `usage.input_tokens=800054`).

### Chat Completions (апстримы без Responses)

| Model ID | Контекст | Max output | Thinking | Vision | Credit |
|---|---|---|---|---|---|
| `kimi-k2.7-code` | 262 144 | 262 144 | не управляется (всегда думает) | ✓ | 1.94 |
| `kimi-k3` | 1 024 000 | 128 000 | не управляется (всегда думает) | ✓ | 4.51 |
| `MiniMax-M3` | 512 000 | 524 288 | off = `thinking:{disabled}`, остальное = `adaptive` | ✓ | 1.47 |
| `hy3` | 192 000 | 32 768 | off/on = `thinking:{disabled/enabled}` | — | 0.75 |
| `zhipu/glm-5.3` | 1M | 131 072 | `reasoning_effort` low/high/max («всегда думает») | — | 2.77 |

Ответы этих моделей на `/responses` — ошибки вида «you must provide a messages parameter» (шлюз проксирует тело как есть на vendor-бэкенды без responses-адаптера).

## Как расширение чинит квирки шлюза

1. **`before_provider_request`** (подмена payload):
   - `deepseek-v4-flash`, `doubao-seed-2.1-pro`, `glm-5.2` отвергают поле `reasoning.summary` (`json: unknown field "summary"`), а pi-ai всегда отправляет его вместе с `reasoning.effort`. Хук вырезает `summary` ровно для этих моделей (effort и `include` сохраняются). `deepseek-v4-pro`, `glm-5.3*`, `qwen*` принимают `summary` — их не трогаем.
   - `MiniMax-M3` принимает только `thinking:{type:"adaptive"|"disabled"}` — хук переписывает pi-ai-овское `{type:"enabled"}` (deepseek-формат) в `{type:"adaptive"}`.
2. **`message_end`** (нормализация переполнения контекста): ошибки шлюза (`Total tokens of image and text exceed…`, `Input tokens exceed the configured limit…`, `Range of input length…`, `OutofContextError`, CJK-варианты) переписываются в `context_length_exceeded: …`, чтобы pi запускал авто-компакцию и ретрай. Rate-limit ошибки намеренно НЕ трогаются.
3. **Динамический каталог** (`fetchModels` в нативной `createProvider`-форме): когда pi разрешает сеть (интерактивный старт, `pi update --models`), расширение тянет `GET /v1/models`, обновляет имена/кредиты, регистрирует новые модели шлюза консервативными дефолтами (chat, text-only, 128K/8K, без thinking-параметров) и сохраняет оверлей в models-store pi — офлайн-старты берут последний успешный снимок. Любая ошибка сети деградирует до статического каталога. Ограничение: оверлей **апсертится** поверх статики, поэтому модели, удалённые со шлюза, остаются в списке до обновления расширения.

## Проверенные возможности шлюза

- Responses: SSE-события стандартные (`response.reasoning_text.delta` — pi-ai его понимает), `store:false`, `prompt_cache_key`, `include:["reasoning.encrypted_content"]` (шифрованный контент не возвращается; reasoning реплеится через summary), `max_output_tokens`, роли `developer` и `system`, function tools + `function_call`/`function_call_output` round-trip, стриминг tool-call дельт.
- Chat: `reasoning_content` в стриме, `stream_options.include_usage`, `max_tokens` и `max_completion_tokens`, `strict:false` в tools, tool round-trip, prompt caching (kimi-k3 возвращал `cached_tokens`).
- Лимиты max output получены из точных 400-ошибок шлюза; контекст qwen — из обрезки входа, hy3 — из ошибки (192 000), doubao — ошибка при >256K.

## Prompt-кэш и `prompt_cache_retention`

Имплицитный префикс-кэш работает на всём шлюзе: повтор промпта ~2.8k токенов с тем же `prompt_cache_key` вернул `cached_tokens` 2048–2816 (qwen3.8-flash, kimi-k2.7-code, glm-5.3-flash). pi отправляет `prompt_cache_key` (= sessionId) в каждом responses-запросе — кэш работает из коробки.

Расширенное удержание `prompt_cache_retention:"24h"` pi шлёт только при `PI_CACHE_RETENTION=long` и только моделям с `supportsLongCacheRetention:true`. Проверено живьём (2026-09-15):

| Маршрут | `24h` |
|---|---|
| deepseek-v4-pro, glm-5.3, glm-5.3-flash, qwen3.7-*/3.8-* (responses) | ✅ 200 |
| kimi-k2.7-code, kimi-k3, MiniMax-M3, hy3, zhipu/glm-5.3 (chat) | ✅ 200 |
| deepseek-v4-flash, doubao-seed-2.1-pro, glm-5.2 (responses) | ❌ `json: unknown field` — флаг выключен, pi им ничего не шлёт |

Включить 24-часовой кэш (имеет смысл для длинных сессий с перерывами) — либо только для этого провайдера, либо глобально:

```
/volcengine cache on        # per-provider, сохраняется в ~/.pi/agent/volcengine-gateway.json
export PI_CACHE_RETENTION=long   # глобально для всех провайдеров pi
```

Стоимость cache-read в каталоге тарифицируется по input-рейту (скидку кэша шлюз не публикует); `cached_tokens` из usage попадают в `usage.cacheRead` pi автоматически.

## Разработка

Предварительные условия: **Node ≥ 22.19** (`engines` в `package.json`). Здесь
`npm install` действительно ставит всё нужное: `@earendil-works/pi-ai`,
`@earendil-works/pi-coding-agent`, `@types/node`, `tsx` и `typescript` объявлены
как `devDependencies` (линейка 0.87.0, на которой расширение проверено; отдельно
прогнано на pi 0.99.1 — 2026-09-30, в клоне с подменой двух pi-пакетов на
глобальные: typecheck + 80/80 зелёные, пинн в этом дереве остаётся 0.87.0), а
`package-lock.json` закоммичен — симлинки на глобальную установку pi не нужны.

```bash
npm install
npm run check        # tsc --noEmit + tsx --test (80 офлайн-тестов: каталог, хуки,
                     # merge/fetch, retention-матрица на уровне payload,
                     # store настроек, /volcengine-команды, endpoint-оверрайд
                     # и probe-детект, виджет, валидация ключа, login-флоу)
```

Быстрый E2E (тратит кредиты подписки):

```bash
export VOLCEAPI_API_KEY=…
pi -ne -e ./index.ts -p --no-session --model volcengine-gateway/qwen3.8-flash:low -- "Say OK"
pi -ne -e ./index.ts -p --no-session --model volcengine-gateway/deepseek-v4-flash:high -- "Say OK"   # хук strip-summary
pi -ne -e ./index.ts -p --no-session --model volcengine-gateway/MiniMax-M3:high -- "Say OK"          # хук adaptive
pi -ne -e ./index.ts -p --no-session --model volcengine-gateway/kimi-k2.7-code:high -- "Say OK"      # chat-путь
PI_CACHE_RETENTION=long pi -ne -e ./index.ts -p --model volcengine-gateway/qwen3.8-flash:low -- "Say OK"  # retention 24h
```

Обновить каталог/цены: `pi update --models`.

## Архитектура

Расширение зарегистрировано нативным `createProvider` (pi-ai): объект-провайдер с `auth.apiKey` (login/check/resolve), `fetchModels` (динамический оверлей + models-store) и api-картой `{"openai-responses", "openai-completions"}` — диспетчеризация по `model.api`. Хуки `before_provider_request` и `message_end` регистрируются отдельно и от формы провайдера не зависят.

## Известные ограничения

- `encrypted_content` шлюзом не выдаётся — reasoning между ходами передаётся как summary-текст (для stateless-режима этого достаточно).
- Контексты `glm-5.3`, `zhipu/glm-5.3`, `doubao-seed-2.1-pro`, `kimi-*`, `MiniMax-M3` взяты из официальных Ark-маршрутов и проб, а не из ответа самого шлюза: там, где шлюз не раскрыл окно своей 400-ошибкой, значение осталось справочным. Если реальное окно маршрута меньше, сработает авто-компакция через хук нормализации.
- `deepseek-v4-flash`, `doubao-seed-2.1-pro`, `glm-5.2` не принимают `prompt_cache_retention` — для них 24h-удержание недоступно (обычный кэш работает).
- Тарификация кредитов приблизительная (1 credit ≈ $1/1M токенов, cache-read = input-рейт); точная бухгалтерия — в панели Volcengine.

### Каталог отстаёт от доков Ark (на 2026-09-22)

Доки Ark / API Gateway обновлялись после верификации каталога 2026-09-15:
заявлены vision-параметры `xhigh` / `image_pixel_limit`, DeepSeek-V4.1-Flash,
Seed-Evolving и AI Model Fallback (2026-09-10). Сводка и чек-лист живых проб —
в [`research/2026-09-22-ark-gateway-docs.md`](research/2026-09-22-ark-gateway-docs.md)
(файл есть в репозитории на GitHub, но **не входит в npm-тарбол**: `files` в
`package.json` перечисляет только `index.ts`, `settings.ts`, `README.md`,
`LICENSE`). Ни одно из этих изменений в каталог не внесено: правило расширения —
значение попадает в `index.ts` и README только после живой пробы
(см. [`AGENTS.md`](AGENTS.md)).
