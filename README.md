# pi-jev-browser

An isolated Playwright Chromium browser for pi, driven by [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) — TypeSafe AI's System One model — called directly through the TypeSafe API, or by the model pi already has configured.

Jev does not see screenshots. The plugin hands it a structured DOM observation and one multiple-choice question per step, and Jev answers with a concrete operation plus a probability distribution over the offered options. That removes the screenshot round trip and the reasoning round trip from every browser step.

**This is not a replacement for `agent_browser`.** It is the other trade: no login state, no extensions, no host environment, every step recorded with its probability, and a much cheaper fast loop. Use it for narrowly scoped goals on public pages. Use a profile-based browser tool when you need the user's session.

## Decision policies

Each step offers the same enumerated choices — every concrete action compared directly against scrolling, waiting, and stopping — and a policy answers which one to take. Only the answerer differs.

| `policy` | Who decides | Needs | Trade-off |
| --- | --- | --- | --- |
| `pi` (default) | The model pi has configured | Nothing extra | `probability` is whatever the model claims, and completion discipline follows that model |
| `typesafe` | [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) via the TypeSafe API | `TYPESAFE_API_KEY` or `typesafe.apiKey` | Better at checking that a requirement is really visible before declaring done; every step is one TypeSafe request |

`pi` is the default because it works with no second credential and no extra API quota. Its weakness is the mirror image: measured on one goal (open a category, then a detail page, stop when the UPC and availability are visible), both `deepseek-flash` and `deepseek-v4-pro` declared `DONE` after two clicks without ever scrolling to the Product Information table, where Jev scrolled twice and then stopped. Clarifying the `DONE` criterion did not change that. What kept the outcome honest was the evidence: `done_unverified` plus a viewport-scoped page text let the calling agent see that the UPC had never been read, and it said so instead of reporting success.

On the same goal, policy `typesafe` completed it in four executed steps (7.1 s) with both required values in the returned page text, and five consecutive direct API calls showed no throttling at all — the Gateway free tier in the same position stopped after five or six requests.

## Install

```bash
pi install /absolute/path/to/pi-jev-browser   # local checkout
pi install npm:pi-jev-browser                 # once published
```

Chromium downloads on the first `jev_run` if Playwright's cache does not already have a matching build (up to ~2 minutes, network required). Nothing is downloaded at pi startup. On Linux the system browser libraries remain an administrator-managed prerequisite; this package does not run sudo.

## Configuration

Optional. Without a config file the plugin allows all HTTP and HTTPS origins, runs headless at 1280×720, records WebM video, and writes artifacts to `~/.pi/agent/data/jev-browser/`.

```bash
cp pi-jev-browser.config.example.json ~/.pi/agent/pi-jev-browser.config.json
```

| Key | Default | Notes |
| --- | --- | --- |
| `policy` | `"pi"` | `pi` uses the model pi has configured; `typesafe` calls the TypeSafe API directly. See [Decision policies](#decision-policies). |
| `allowedOrigins` | `["http://*", "https://*"]` | `*` wildcards, matched against the origin. Narrow this for sensitive work. |
| `headless` | `true` | On macOS a rejected headless launch falls back to a visible window. |
| `recordVideo` | `true` | Finalized by `jev_stop`. |
| `showCursor`, `showClickIndicators` | `true` | Overlay for screenshots, stream, and recordings. |
| `viewport` | `1280×720` | Clamped to 640–2560 × 480–1600. |
| `outputDir` | `~/.pi/agent/data/jev-browser` | One directory per browser session. |
| `stream` | `{enabled:false, intervalMs:1000}` | `jev_stream` can start it on demand. |
| `typesafe.apiKey` | — | Used when `TYPESAFE_API_KEY` is not set. |
| `typesafe.model` | `jev-latest` | TypeSafe model alias for the decision step. |

Credentials resolve in this order: `TYPESAFE_API_KEY`, then `typesafe.apiKey`; `TYPESAFE_MODEL`, then `typesafe.model`. `PI_JEV_BROWSER_CONFIG` overrides the config path. Credentials are read on every run, never written into the browser's environment, and never returned in tool results. Both settings apply to policy `typesafe` only; policy `pi` resolves its model through pi's own provider configuration. Field values are always filled by pi's configured model, because Jev generates no text.

With policy `typesafe`, **every step costs one request**, so a 20-step run makes up to 20 of them. TypeSafe documents `429 Too Many Requests` and `529 Overloaded` as back-off-and-retry. The loop does not retry: retrying inside the loop would spend the step budget on requests that keep failing. Those responses end the run as `interrupted` with failure category `rate_limited` or `overloaded`, take no action for the step being decided, and tell the caller to wait.

## Tools

| Tool | Purpose |
| --- | --- |
| `jev_run` | Start or reuse the browser, capture before/after screenshots, and run the Jev loop toward one goal. |
| `jev_actions` | Manual click/type/scroll/drag batch. **Does not call Jev.** Escape hatch only. |
| `jev_state` | URLs, titles, tabs, viewport, start time. |
| `jev_logs` | Console messages, page errors, failed requests, navigations, blocked downloads, security blocks. |
| `jev_stream` | Tokenized live screenshot + log viewer bound to `127.0.0.1`. |
| `jev_stop` | Cancel any in-flight run, close the browser, finalize video. |

A run is bounded to 20 steps by default (60 max) and 100 seconds. `jev_run` returns a status, the executed step count, `elapsedMs`, a JSONL trace path, screenshots on disk, and text evidence of the page the run stopped on: URL, title, an excerpt of the visible text, and the number of actionable targets observed.

**Verification is text-first.** The final screenshot is attached as an image content block only when the active model declares image input. pi also strips images when `images.blockImages` is set, and extensions cannot read that setting — so the result always carries text evidence, and the verification line states which path applies, names the `Image reading is disabled` symptom, and forbids reporting success from the status alone.

Statuses are `done_unverified`, `blocked`, `needs_review`, `uncertain`, `step_limit`, `evaluation_limit`, and `interrupted`. There is deliberately no `done`: `done_unverified` means Jev believes the goal is complete and the calling agent must verify independently before reporting success.

## Safety

Three layers exist, and only the first one is enforcement:

1. **Mechanical.** Navigation allowlist enforced in the request router; downloads refused and logged; service workers blocked; extensions and file-system access disabled; the browser process gets an empty environment; password, file, and hidden inputs are never observed; the model can only select from server-generated target IDs, so its output can never become a selector, URL, or code.
2. **Model guidance.** Jev is instructed to return `REVIEW` before messages, posts, orders, payments, bookings, deletions, permission changes, sensitive-data entry, CAPTCHAs, or security warnings. This is guidance, not a deterministic boundary.
3. **Agent instructions.** The tool guidelines tell pi to treat page content as untrusted, to ask before consequential actions, to never type secrets, and to verify `done_unverified` independently. These are instructions to another model, not guarantees.

Page text, visible field values, and the goal are sent to the decision model — the TypeSafe API under policy `typesafe`, your configured provider under policy `pi` — and field values are sent to pi's model to be filled. Password and file fields are excluded, but other sensitive content is **not** automatically redacted. Delegate only narrowly scoped tasks.

## Scope and limits

- **Not a vision agent.** No screenshots are sent to Jev. Screenshots exist for the calling agent's verification and for the user.
- **DOM coverage.** Frames, shadow DOM, canvas controls, nested scrolling, uploads, and arbitrary keyboard widgets are outside the observation loop. Use `jev_actions` there.
- **Observation caps.** 200 action targets, 6,000 visible characters, 50 selected options, and up to 50 offscreen control labels per direction. Dense pages can lose controls.
- **No persistent state.** Every browser start creates a fresh context: no cookies, no logins, no profiles.
- **Not desktop control.** This is a browser harness. Full desktop control would need a VM/container backend and an OS input adapter.
- **Unbenchmarked.** End-to-end speed and live-model reliability have not been measured.
- **Memory is narrow.** The last ten actions are retained in memory per goal within one browser session, and are dropped when the goal changes. Nothing is persisted.

The loop retries only reads invalidated by a document replacement, up to five times. A browser mutation is **never** retried: a failed run may still have applied an action, so inspect the page before continuing. Three non-wait actions without observable progress end the run as `blocked`.

## Porting notes

Ported from [`cline/plugins` → `plugins/jev-browser`](https://github.com/cline/plugins/tree/main/plugins/jev-browser) (v0.2.2). The observation layer, decision loop, action executor, config, stream, overlay, and browser setup are the upstream code, unchanged apart from names. What the host boundary required:

- **Cancellation.** Cline passes tool context over JSON IPC, so the upstream plugin could not receive a live `AbortSignal` and managed cancellation itself — Escape did not stop a run. Pi passes a real `signal` into `execute()`, so host cancellation now works and `jev_stop` is cleanup rather than the only stop button.
- **Screenshots.** Upstream returned a host-specific result array; here the final image becomes a Pi `{type:"image"}` content block, so verification no longer depends on the client rendering an artifact path.
- **One browser, not a map.** Upstream keyed sessions by Cline session id. A pi extension instance is one session, so the manager holds one browser and `session_shutdown` closes it.
- **Rules → guidelines.** The upstream global safety rule became per-tool `promptGuidelines`, each naming its tool, plus `executionMode: "sequential"` on the tools that drive the shared page.
- **No dashboard events.** Upstream emitted seven `jev_browser_update` events for the Cline UI. Pi has no equivalent surface; artifacts, the trace, and tool results carry the same information.
- **Dependencies.** `zod` was unused and was dropped. Upstream reached Jev through Vercel AI Gateway with `ai` and `@ai-sdk/gateway`; both are gone, because TypeSafe's own API takes the same `state` + `questions` body the loop already builds. The validation those packages provided moved into `parseChoiceAnswer`, narrowed to what the loop actually needs: only an answer that names no offered option is fatal, because a doubtful probability distribution must never kill a run that has already clicked things. Its own value is reported when it is a usable number and marked unknown otherwise.
- **Throttling is named, and failures explain themselves.** Upstream reported any evaluation failure as an unexplained interruption. HTTP 429 and 529 now carry their own failure categories, `rate_limited` and `overloaded`, and every failure records a bounded single-line `detail`. That last part is not cosmetic: an unexplained four-step failure is what prompted this change, and the detail line is what makes the next one diagnosable.
- **Input validation.** `jev_actions` now validates every action in the batch before executing any of it, so a malformed action can no longer leave earlier actions half-applied.
- **Pluggable decision policy.** The decision step became the `JevPolicy` seam the upstream interface hinted at: `policy: "pi"` answers it with the model pi already has configured, so the loop needs no second credential, while `policy: "typesafe"` calls the TypeSafe API directly. Vercel AI Gateway is no longer a dependency of any kind.
- **Verification without vision.** Upstream handed back screenshots, so a text-only model could not check a `done_unverified` claim at all. Runs now also return the stopped page's URL, title, and visible-text excerpt, produced by the same observation layer, and the image is attached only when the model declares image input. Measured on one goal: the payload dropped from 1.38 MB to 164 KB with a text-only model, while the agent's verification went from "claim is unverified" to naming the book title and price.

## Development

```bash
bun install
bun run check   # tsc --noEmit
bun run test    # node --test; browser tests need Chromium and a display
```

Tests use local HTML and mocked model responses, including the TypeSafe transport against a fake HTTP response. They make no paid model calls.

To exercise the loop for real, run it: the default `pi` policy needs no key at all, and `policy: "typesafe"` with `TYPESAFE_API_KEY` set uses Jev.

```bash
pi -e ./extensions/jev-browser.ts -p "Use jev_run with url https://books.toscrape.com and goal: open the Travel category and stop when the first book's title is visible."
```

## License

Apache-2.0. Upstream `cline/plugins` is Apache-2.0 (its plugin `package.json` says MIT, but the repository ships no separate plugin license, so the repository license is followed here). Upstream author: Bee, Cline Bot Inc.
