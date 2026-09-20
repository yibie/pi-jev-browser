import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, {
	modelAcceptsImages,
	verificationHint,
} from "../extensions/jev-browser.ts";
import { normalizeKey } from "../src/actions.ts";
import { isUrlAllowed, readConfig } from "../src/config.ts";

interface RegisteredTool {
	name: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	executionMode?: string;
	parameters: {
		type: string;
		required?: string[];
		properties: Record<string, any>;
	};
}

function loadExtension() {
	const tools = new Map<string, RegisteredTool>();
	const events = new Map<string, unknown>();
	extension({
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: unknown) {
			events.set(event, handler);
		},
	} as unknown as ExtensionAPI);
	return { tools, events };
}

test("registers the complete Jev Browser surface", () => {
	const { tools, events } = loadExtension();
	assert.deepEqual([...tools.keys()], [
		"jev_run",
		"jev_actions",
		"jev_state",
		"jev_logs",
		"jev_stream",
		"jev_stop",
	]);
	// The browser must be released when pi replaces or exits the session.
	assert.ok(events.has("session_shutdown"));
	// Serialized: these drive one shared page, and pi may call tools concurrently.
	for (const name of ["jev_run", "jev_actions", "jev_stream", "jev_stop"])
		assert.equal(tools.get(name)?.executionMode, "sequential", name);
	// Safety rules live on the tools they constrain, and name them.
	for (const tool of tools.values())
		for (const guideline of tool.promptGuidelines ?? [])
			assert.ok(
				guideline.includes(tool.name) || guideline.includes("Jev"),
				`guideline must name its tool: ${guideline.slice(0, 60)}`,
			);
	const guidelines = tools.get("jev_run")?.promptGuidelines ?? [];
	assert.ok(guidelines.some((line) => line.includes("done_unverified")));
	assert.ok(guidelines.some((line) => line.includes("jev_stop")));
	assert.ok(
		(tools.get("jev_stop")?.promptGuidelines ?? []).some((line) =>
			line.includes("jev_stop"),
		),
	);
	assert.ok(
		(tools.get("jev_actions")?.promptGuidelines ?? []).some((line) =>
			line.includes("never use it automatically"),
		),
	);
});

test("tool schemas keep the Jev Browser bounds", () => {
	const { tools } = loadExtension();
	const run = tools.get("jev_run")!.parameters;
	assert.equal(run.type, "object");
	assert.deepEqual(run.required, ["goal"]);
	assert.equal(run.properties.goal.maxLength, 12_000);
	assert.equal(run.properties.maxSteps.maximum, 60);
	assert.equal(run.properties.minProbability.maximum, 1);

	const actions = tools.get("jev_actions")!.parameters;
	assert.deepEqual(actions.required, ["actions"]);
	assert.equal(actions.properties.actions.maxItems, 50);
	assert.equal(actions.properties.includeScreenshot.type, "boolean");

	// Google rejects unions and literals in tool schemas, so enums stay flat.
	assert.deepEqual(tools.get("jev_stream")!.parameters.properties.action, {
		type: "string",
		enum: ["start", "status", "stop"],
	});
	assert.ok(
		(actions.properties.actions.items.properties.type as { enum: string[] }).enum.includes(
			"double_click",
		),
	);
	const drag = actions.properties.actions.items.properties.path;
	assert.match(JSON.stringify(drag), /"maxItems":2/);
	assert.equal(tools.get("jev_state")!.parameters.type, "object");
});

test("verification does not depend on the model being able to see images", () => {
	assert.equal(modelAcceptsImages({ input: ["text", "image"] }), true);
	assert.equal(modelAcceptsImages({ input: ["text"] }), false);
	assert.equal(modelAcceptsImages(undefined), false);

	const visual = verificationHint(true);
	const textual = verificationHint(false);
	for (const hint of [visual, textual])
		assert.match(hint, /done_unverified is a claim/, hint.slice(0, 40));
	// Pi turns blocked images into this exact placeholder, so the model can name the cause.
	assert.match(visual, /Image reading is disabled/);
	assert.match(visual, /blockImages/);
	// Without vision the run still has to be checkable, and status alone is not enough.
	assert.match(textual, /cannot receive images/);
	assert.match(textual, /final page text/);
	assert.match(textual, /Never report success from the status alone/);
});

test("matches configured origins and blocks unsupported schemes", () => {
	const patterns = ["https://*.example.com", "http://localhost:*"];
	assert.equal(isUrlAllowed("https://app.example.com/path", patterns), true);
	assert.equal(isUrlAllowed("http://localhost:4173", patterns), true);
	assert.equal(isUrlAllowed("https://example.net", patterns), false);
	assert.equal(isUrlAllowed("file:///etc/passwd", ["*"]), false);
});

test("loads bounded config values", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-jev-browser-"));
	const path = join(directory, "config.json");
	try {
		writeFileSync(
			path,
			JSON.stringify({
				policy: "typesafe",
				allowedOrigins: ["https://example.com"],
				viewport: { width: 99, height: 9999 },
				stream: { enabled: true, intervalMs: 10 },
			}),
		);
		const config = readConfig(path);
		assert.equal(config.policy, "typesafe");
		assert.deepEqual(config.allowedOrigins, ["https://example.com"]);
		assert.deepEqual(config.viewport, { width: 640, height: 1600 });
		assert.deepEqual(config.stream, { enabled: true, intervalMs: 250 });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("uses complete defaults when configuration is omitted", () => {
	const config = readConfig(join(tmpdir(), "missing-pi-jev-browser.config.json"));
	// pi's own model by default: no second credential, no extra API quota.
	assert.equal(config.policy, "pi");
	assert.deepEqual(config.allowedOrigins, ["http://*", "https://*"]);
	assert.equal(config.headless, true);
	assert.equal(config.recordVideo, true);
	assert.equal(config.showCursor, true);
	assert.equal(config.showClickIndicators, true);
	assert.deepEqual(config.viewport, { width: 1280, height: 720 });
	assert.deepEqual(config.stream, { enabled: false, intervalMs: 1000 });
	assert.equal(isUrlAllowed("https://openai.com", config.allowedOrigins), true);
	assert.equal(
		isUrlAllowed("http://example.test:8080", config.allowedOrigins),
		true,
	);
	assert.equal(isUrlAllowed("file:///etc/passwd", config.allowedOrigins), false);
	assert.match(config.outputDir, /\.pi\/agent\/data\/jev-browser$/);
});

test("normalizes Jev Browser key aliases", () => {
	assert.equal(normalizeKey("CTRL"), "Control");
	assert.equal(normalizeKey("ARROWDOWN"), "ArrowDown");
	assert.equal(normalizeKey("a"), "a");
});
