import { observe, waitForDocument } from "./jev-browser.ts";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { executeActions } from "./actions.ts";
import { ensureChromium } from "./browser-setup.ts";
import { isUrlAllowed, readConfig } from "./config.ts";
import { type RunInput, type RunMemory, type RunStep, runJev } from "./jev-run.ts";
import type { JevPolicy } from "./jev-model.ts";
import { installRecordingOverlay } from "./recording-overlay.ts";
import { startStream } from "./stream.ts";
import type {
	ActiveBrowserSession,
	BrowserAction,
	BrowserLogEntry,
	BrowserState,
	JevBrowserConfig,
} from "./types.ts";

export interface LaunchInput {
	url?: string;
	headless?: boolean;
	recordVideo?: boolean;
	showCursor?: boolean;
	showClickIndicators?: boolean;
}

export interface Screenshot {
	state: BrowserState;
	artifactPath: string;
	png: Buffer;
}

export interface RunResult {
	failure?: { stage: string; category: string; detail?: string };
	status: string;
	message: string;
	steps: RunStep[];
	elapsedMs: number;
	tracePath: string;
	initialScreenshot: { artifactPath: string; state: BrowserState };
	finalScreenshot: { artifactPath: string; state: BrowserState } | null;
	finalPng?: Buffer;
	screenshotWarning?: string;
	/**
	 * Text evidence of the page the run stopped on. Verification must not depend
	 * on vision: a model that cannot receive images still needs something it can
	 * check a done_unverified claim against.
	 */
	finalPage?: {
		url: string;
		title: string;
		targets: number;
		offscreen: number;
		scrolled: boolean;
		text: string;
	};
}

export class JevBrowserManager {
	private session?: ActiveBrowserSession;
	private memory?: RunMemory;
	private running?: AbortController;

	private async start(input: LaunchInput, signal?: AbortSignal) {
		await this.closeSession().catch(() => undefined);
		const config = readConfig();
		const url = input.url?.trim() || "about:blank";
		assertUrlAllowed(url, config);
		const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
		const outputDir = join(config.outputDir, id);
		await mkdir(join(outputDir, "screenshots"), { recursive: true });
		if (input.recordVideo ?? config.recordVideo)
			await mkdir(join(outputDir, "videos"), { recursive: true });

		signal?.throwIfAborted();
		await ensureChromium();

		const requestedHeadless = input.headless ?? config.headless;
		const launchOptions = {
			// On macOS, forcing Chromium's Linux sandbox can deadlock or crash when
			// the host runs from an app-bundle subprocess. The full Chromium
			// channel keeps its native platform sandbox and supports modern headless.
			...(process.platform === "darwin"
				? { channel: "chromium" as const }
				: { chromiumSandbox: true }),
			timeout: 20_000,
			env: {},
			args: [
				"--disable-extensions",
				"--disable-file-system",
				`--window-size=${config.viewport.width},${config.viewport.height}`,
			],
		};
		let actualHeadless = requestedHeadless;
		let launchWarning: string | undefined;
		let browser: Browser;
		try {
			browser = await chromium.launch({
				...launchOptions,
				headless: requestedHeadless,
			});
		} catch (error) {
			if (process.platform !== "darwin" || !requestedHeadless) throw error;
			// Headless Chromium may be rejected by the macOS app sandbox even though
			// a normal browser window is allowed. Fall back instead of consuming the
			// entire tool timeout.
			browser = await chromium.launch({ ...launchOptions, headless: false });
			actualHeadless = false;
			launchWarning =
				"Headless Chromium was unavailable in this process, so Jev Browser started a visible browser window.";
		}
		const browserContext = await browser.newContext({
			viewport: config.viewport,
			acceptDownloads: false,
			serviceWorkers: "block",
			...((input.recordVideo ?? config.recordVideo)
				? {
						recordVideo: {
							dir: join(outputDir, "videos"),
							size: config.viewport,
						},
					}
				: {}),
		});
		await installRecordingOverlay(browserContext, {
			showCursor: input.showCursor ?? config.showCursor,
			showClickIndicators:
				input.showClickIndicators ?? config.showClickIndicators,
		});
		const page = await browserContext.newPage();
		const session: ActiveBrowserSession = {
			browser,
			context: browserContext,
			page,
			video: page.video() ?? undefined,
			id,
			outputDir,
			startedAt: new Date().toISOString(),
			logs: [],
			nextLogId: 1,
		};
		this.session = session;
		this.memory = undefined;
		this.attachObservability(session, config);

		try {
			if (url !== "about:blank")
				await page.goto(url, {
					waitUntil: "domcontentloaded",
					timeout: 20_000,
				});
			if (config.stream.enabled)
				await this.startStreamForSession(session, config.stream.intervalMs);
		} catch (error) {
			await this.stop().catch(() => undefined);
			throw error;
		}

		const state = await this.stateForSession(session, config);
		return {
			...state,
			outputDir,
			streamUrl: session.stream?.url,
			actualHeadless,
			launchWarning,
			message: "Browser started.",
		};
	}

	async screenshot(
		input: { label?: string },
		signal?: AbortSignal,
	): Promise<Screenshot> {
		const session = this.requireSession();
		const config = readConfig();
		const label = sanitizeLabel(input.label ?? "screenshot");
		const path = join(
			session.outputDir,
			"screenshots",
			`${Date.now()}-${label}.png`,
		);
		signal?.throwIfAborted();
		await waitForDocument(session.page);
		const png = await session.page.screenshot({
			path,
			type: "png",
			timeout: 5000,
		});
		const state = await this.stateForSession(session, config);
		return { state, artifactPath: path, png };
	}

	async actions(
		input: { actions: BrowserAction[]; includeScreenshot?: boolean },
		options: { signal?: AbortSignal } = {},
	) {
		const session = this.requireSession();
		const config = readConfig();
		const end = this.beginWork(options.signal);
		try {
			await executeActions(session.page, input.actions, {
				assertUrlAllowed: (url) => assertUrlAllowed(url, config),
				signal: AbortSignal.any([
					this.running!.signal,
					AbortSignal.timeout(115_000),
				]),
			});
			const state = await this.stateForSession(session, config);
			if (input.includeScreenshot === false)
				return {
					state,
					executed: input.actions.map((action) => action.type),
					screenshot: undefined as Screenshot | undefined,
				};
			return {
				state,
				executed: input.actions.map((action) => action.type),
				screenshot: await this.screenshot({ label: "after-actions" }, options.signal),
			};
		} finally {
			end();
		}
	}

	async run(
		input: RunInput & LaunchInput,
		options: {
			signal?: AbortSignal;
			onStep?: (step: RunStep) => Promise<void>;
			policy: JevPolicy;
		} ,
	): Promise<RunResult> {
		const end = this.beginWork(options.signal);
		try {
			if (!this.session) await this.start(input, options.signal);
			else if (input.url) {
				assertUrlAllowed(input.url, readConfig());
				await this.requireSession().page.goto(input.url, {
					waitUntil: "domcontentloaded",
					timeout: 20_000,
				});
			}
			this.running!.signal.throwIfAborted();
			const session = this.requireSession();
			const tracePath = join(session.outputDir, `jev-${randomUUID()}.jsonl`);
			const initial = await this.screenshot(
				{ label: "jev-initial" },
				options.signal,
			);
			const memory = this.memory ?? { goal: input.goal, actions: [] };
			this.memory = memory;
			const result = await runJev(input, {
				memory,
				page: () => session.page,
				signal: this.running!.signal,
				policy: options.policy,
				onStep: async (step) => {
					await appendFile(tracePath, `${JSON.stringify(step)}\n`);
					await options.onStep?.(step);
				},
			});
			await appendFile(
				tracePath,
				`${JSON.stringify({ type: "result", ...result })}\n`,
			);
			let final: Screenshot | undefined;
			try {
				final = await this.screenshot({ label: "jev-final" }, options.signal);
			} catch {
				/* Browser may have been stopped during cancellation. */
			}
			return {
				...result,
				tracePath,
				initialScreenshot: {
					artifactPath: initial.artifactPath,
					state: initial.state,
				},
				finalScreenshot: final
					? { artifactPath: final.artifactPath, state: final.state }
					: null,
				finalPng: final?.png,
				finalPage: await this.finalPage(options.signal),
				screenshotWarning: final
					? undefined
					: "Final screenshot unavailable; the browser may have closed. Outcome is unverified.",
			};
		} finally {
			end();
		}
	}

	/** Read-only text evidence of the page the run stopped on. Never fatal. */
	private async finalPage(signal?: AbortSignal) {
		const session = this.session;
		if (!session || session.page.isClosed() || signal?.aborted) return undefined;
		try {
			const snapshot = await observe(session.page, signal);
			try {
				return {
					url: snapshot.data.url,
					title: snapshot.data.title,
					targets: snapshot.data.targets.length,
					offscreen:
						(snapshot.data.offscreenControls?.above.length ?? 0) +
						(snapshot.data.offscreenControls?.below.length ?? 0),
					scrolled: snapshot.data.scrollUp,
					// The observation layer already bounds this at 6,000 chars, which is
					// what the model sees on every step. A second, tighter cap here
					// silently drops the very content a goal gets verified against.
					text: snapshot.data.text,
				};
			} finally {
				await snapshot.dispose().catch(() => undefined);
			}
		} catch {
			return undefined;
		}
	}

	async state(): Promise<BrowserState> {
		return this.session
			? this.stateForSession(this.session, readConfig())
			: ({
					active: false,
					pages: [],
					viewport: readConfig().viewport,
				} satisfies BrowserState);
	}

	logs(input: { afterId?: number; limit?: number }) {
		const session = this.requireSession();
		const afterId = Number.isFinite(input.afterId) ? Number(input.afterId) : 0;
		const limit = Math.min(1000, Math.max(1, Number(input.limit) || 200));
		const logs = session.logs
			.filter((entry) => entry.id > afterId)
			.slice(-limit);
		return {
			logs,
			lastId: logs.at(-1)?.id ?? afterId,
			total: session.logs.length,
		};
	}

	async stream(input: { action: "start" | "status" | "stop"; intervalMs?: number }) {
		const session = this.requireSession();
		if (input.action === "stop") {
			await session.stream?.stop();
			session.stream = undefined;
			return { active: false };
		}
		if (input.action === "start" && !session.stream) {
			await this.startStreamForSession(
				session,
				Math.min(
					10_000,
					Math.max(250, input.intervalMs ?? readConfig().stream.intervalMs),
				),
			);
		}
		return { active: Boolean(session.stream), url: session.stream?.url };
	}

	/** Cancels any in-flight run, then closes the browser and finalizes video. */
	async stop() {
		this.running?.abort();
		return this.closeSession();
	}

	/**
	 * Closes the browser without touching the caller's in-flight controller:
	 * start() runs inside that controller and must not abort itself.
	 */
	private async closeSession() {
		const session = this.session;
		if (!session)
			return {
				active: false as const,
				message: "No browser is active.",
			};
		this.session = undefined;
		this.memory = undefined;
		await settleWithin(session.stream?.stop(), 3_000);
		await settleWithin(session.context.close(), 8_000);
		let videoPath: string | undefined;
		try {
			videoPath = await withTimeout(
				session.video?.path(),
				8_000,
				"Video finalization",
			);
		} catch {
			videoPath = undefined;
		}
		await settleWithin(session.browser.close(), 3_000);
		return { active: false as const, outputDir: session.outputDir, videoPath };
	}

	private beginWork(hostSignal?: AbortSignal) {
		if (this.running)
			throw new Error(
				"A browser operation is active. Wait for it, or cancel with jev_stop.",
			);
		const controller = new AbortController();
		const relay = () => controller.abort();
		if (hostSignal?.aborted) controller.abort();
		else hostSignal?.addEventListener("abort", relay, { once: true });
		this.running = controller;
		return () => {
			hostSignal?.removeEventListener("abort", relay);
			this.running = undefined;
		};
	}

	private requireSession() {
		if (!this.session)
			throw new Error(
				"No browser is active. Call jev_run with a goal and initial URL first.",
			);
		return this.session;
	}

	private async stateForSession(
		session: ActiveBrowserSession,
		config: JevBrowserConfig,
	): Promise<BrowserState> {
		const pages = await Promise.all(
			session.context.pages().map(async (page, index) => ({
				index,
				title: await page.title().catch(() => ""),
				url: page.url(),
			})),
		);
		return {
			active: true,
			currentUrl: session.page.url(),
			pageTitle: await session.page.title().catch(() => ""),
			pages,
			startedAt: session.startedAt,
			viewport: config.viewport,
		};
	}

	private attachObservability(
		session: ActiveBrowserSession,
		config: JevBrowserConfig,
	) {
		void session.context.route("**/*", async (route) => {
			const request = route.request();
			if (
				request.isNavigationRequest() &&
				!isUrlAllowed(request.url(), config.allowedOrigins)
			) {
				this.addLog(session, {
					type: "security",
					level: "blocked",
					text: "Blocked navigation outside allowedOrigins.",
					url: request.url(),
				});
				await route.abort("blockedbyclient");
				return;
			}
			await route.continue();
		});

		const attachPage = (page: Page) => {
			page.on("console", (message) =>
				this.addLog(session, {
					type: "console",
					level: message.type(),
					text: message.text(),
					url: page.url(),
				}),
			);
			page.on("pageerror", (error) =>
				this.addLog(session, {
					type: "pageerror",
					level: "error",
					text: error.message,
					url: page.url(),
				}),
			);
			page.on("requestfailed", (request) =>
				this.addLog(session, {
					type: "requestfailed",
					level: "error",
					text: request.failure()?.errorText ?? "Request failed",
					url: request.url(),
				}),
			);
			page.on("download", (download) =>
				this.addLog(session, {
					type: "download",
					level: "blocked",
					text: `Download blocked: ${download.suggestedFilename()}`,
					url: page.url(),
				}),
			);
			page.on("framenavigated", (frame) => {
				if (frame === page.mainFrame())
					this.addLog(session, {
						type: "navigation",
						level: "info",
						text: frame.url(),
						url: frame.url(),
					});
			});
		};
		attachPage(session.page);
		session.context.on("page", (page) => {
			attachPage(page);
			session.page = page;
		});
	}

	private addLog(
		session: ActiveBrowserSession,
		input: Omit<BrowserLogEntry, "id" | "timestamp">,
	) {
		const entry: BrowserLogEntry = {
			id: session.nextLogId++,
			timestamp: new Date().toISOString(),
			...input,
		};
		session.logs.push(entry);
		if (session.logs.length > 5000)
			session.logs.splice(0, session.logs.length - 5000);
	}

	private async startStreamForSession(
		session: ActiveBrowserSession,
		intervalMs: number,
	) {
		session.stream = await startStream(session, { intervalMs });
	}
}

function assertUrlAllowed(url: string, config: JevBrowserConfig) {
	if (!isUrlAllowed(url, config.allowedOrigins)) {
		throw new Error(
			`Navigation blocked by pi-jev-browser.config.json: ${url}`,
		);
	}
}

function sanitizeLabel(value: string) {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 64) || "screenshot"
	);
}

async function settleWithin(
	promise: Promise<unknown> | undefined,
	timeoutMs: number,
) {
	if (!promise) return;
	await withTimeout(promise, timeoutMs, "Browser cleanup").catch(
		() => undefined,
	);
}

async function withTimeout<T>(
	promise: Promise<T> | undefined,
	timeoutMs: number,
	label: string,
): Promise<T | undefined> {
	if (!promise) return undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
