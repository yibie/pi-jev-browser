import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiModelPolicy } from "../src/pi-model.ts";
import test from "node:test";

test("manager reuses one browser, guards concurrency, and honours abort signals", async () => {
	const directory = mkdtempSync(join(tmpdir(), "jev-runtime-"));
	const config = join(directory, "config.json");
	writeFileSync(
		config,
		JSON.stringify({ outputDir: directory, recordVideo: false }),
	);
	process.env.PI_JEV_BROWSER_CONFIG = config;
	const { JevBrowserManager } = await import("../src/runtime.ts");
	const manager = new JevBrowserManager();
	// Visible text comfortably longer than the 1,500-char cap this used to apply,
	// with the marker past that point: a shorter excerpt would hide the very
	// string a goal is verified against.
	const server = createServer((_req, res) =>
		res.end(
			`<h1>Ready</h1><p>${"padding ".repeat(230)}</p><p>UPC a22124811bfa8350</p>`,
		),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No test server address");
	const url = `http://127.0.0.1:${address.port}`;

	// A scripted policy: the manager owns the browser, not the decisions.
	const policy = createPiModelPolicy(
		async () => '{"choice":"DONE","probability":1}',
	);

	try {
		const run = await manager.run(
			{ goal: "Observe the Ready heading", url },
			{ policy },
		);
		assert.equal(run.status, "done_unverified");
		assert.ok(existsSync(run.tracePath));
		assert.ok(existsSync(run.initialScreenshot.artifactPath));
		assert.ok(
			run.finalScreenshot && existsSync(run.finalScreenshot.artifactPath),
		);
		// The final image becomes a Pi image content block in the extension.
		assert.ok(run.finalPng && run.finalPng.byteLength > 0);
		// A model that cannot receive images still gets text evidence to verify against.
		assert.match(run.finalPage?.text ?? "", /Ready/);
		assert.match(run.finalPage?.url ?? "", /^http:\/\/127\.0\.0\.1:/);
		assert.match(
			run.finalPage?.text ?? "",
			/a22124811bfa8350/,
			"final page text must not be truncated below the observation budget",
		);
		assert.equal(run.finalPage?.scrolled, false);

		const second = await manager.run(
			{ goal: "Observe the Ready heading" },
			{ policy },
		);
		assert.equal(
			second.initialScreenshot.state.startedAt,
			run.initialScreenshot.state.startedAt,
		);
		assert.notEqual(
			second.finalScreenshot?.artifactPath,
			run.finalScreenshot?.artifactPath,
		);

		// One mutation at a time, and jev_stop cancels an in-flight batch.
		const waiting = manager.actions(
			{ actions: [{ type: "wait", ms: 30_000 }], includeScreenshot: false },
			{},
		);
		const cancelled = assert.rejects(waiting, /abort/i);
		await assert.rejects(
			manager.actions({ actions: [{ type: "wait", ms: 1 }] }, {}),
			/active/,
		);
		await manager.stop();
		await cancelled;

		// pi's own tool signal cancels in-flight work without jev_stop.
		await manager.run({ goal: "Observe the Ready heading", url }, { policy });
		const controller = new AbortController();
		const hostCancelled = manager.actions(
			{ actions: [{ type: "wait", ms: 30_000 }], includeScreenshot: false },
			{ signal: controller.signal },
		);
		const hostAbort = assert.rejects(hostCancelled, /abort/i);
		controller.abort();
		await hostAbort;
		// The guard is released even when the host aborts, and the browser survives.
		await manager.actions({ actions: [{ type: "wait", ms: 1 }] }, {});
		assert.equal((await manager.state()).active, true);

		// A malformed batch is rejected before any action runs.
		await assert.rejects(
			manager.actions(
				{
					actions: [
						{ type: "wait", ms: 1 },
						{ type: "scroll" } as never,
					] as never,
				},
				{},
			),
			/scroll requires numeric deltaX and deltaY/,
		);
	} finally {
		await manager.stop();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		rmSync(directory, { recursive: true, force: true });
	}
});
