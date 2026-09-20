import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { verificationGate } from "../src/gate.ts";
import type { Observation } from "../src/jev-browser.ts";
import { type RunStep, runJev } from "../src/jev-run.ts";

const base: Observation = {
	url: "https://example.test",
	title: "Example",
	text: "Nothing to see",
	targets: [{ id: "1", operation: "CLICK", label: "Continue", value: "" }],
	scrollUp: false,
	scrollDown: false,
};

test("a verification gate needs the announcement and a control that passes it", () => {
	const gate = (over: Partial<Observation>) =>
		verificationGate({
			...base,
			...over,
			targets: over.targets ?? base.targets,
		});
	// Both present: refused.
	assert.deepEqual(
		gate({
			text: "Please verify that you are human",
			targets: [{ id: "1", operation: "CLICK", label: "Verify", value: "" }],
		}),
		{ phrase: "verify that you are human", target: "Verify" },
	);
	assert.equal(
		gate({
			title: "Checking your browser",
			targets: [
				{ id: "1", operation: "CLICK", label: "I am not a robot", value: "" },
			],
		})?.target,
		"I am not a robot",
	);
	// A widget that lives in an iframe is invisible to the observation, so the
	// control is the only thing that can distinguish a gate from prose in that case.
	assert.equal(
		gate({
			text: "We use a CAPTCHA to keep bots out",
			targets: [{ id: "1", operation: "CLICK", label: "Home", value: "" }],
		}),
		undefined,
	);
	assert.equal(
		gate({
			targets: [{ id: "1", operation: "CLICK", label: "Verify email", value: "" }],
		}),
		undefined,
	);
	// Controls that leave the gate are not evidence of one.
	assert.equal(
		gate({
			text: "captcha",
			targets: [{ id: "1", operation: "CLICK", label: "Dismiss", value: "" }],
		}),
		undefined,
	);
	assert.equal(gate({}), undefined);
});

test("the gate stops the run before the policy is consulted", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.setContent(
			"<h1>Verify that you are human</h1><button>Continue</button>",
		);
		let policyCalls = 0;
		const steps: RunStep[] = [];
		const result = await runJev(
			{ goal: "Read the page" },
			{
				page: () => page,
				onStep: async (step) => {
					steps.push(step);
				},
				policy: {
					async choose(observation) {
						policyCalls++;
						return {
							operation: "CLICK",
							probability: 1,
							target: observation.targets.find((t) => t.label === "Continue"),
						};
					},
					async text() {
						return "unused";
					},
				},
			},
		);
		assert.equal(result.status, "needs_review");
		assert.equal(policyCalls, 0, "the policy must never see this page");
		assert.equal(result.steps.length, 0);
		assert.equal(steps.at(-1)?.reason, "verification_gate");
		assert.match(result.message, /does not complete verification challenges/);
	} finally {
		await browser.close();
	}
});

test("a cycle between known states is stopped, a sweep over new ones is not", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		// Two controls whose result is a state the run can come back to.
		await page.setContent(
			`<button onclick="document.body.dataset.at='a'">Alpha</button><button onclick="document.body.dataset.at='b'">Beta</button><p id="marker">start</p>`,
		);
		const clickLabel = (observation: Observation, label: string) => ({
			operation: "CLICK",
			probability: 1,
			target: observation.targets.find((t) => t.label === label),
		});
		let turn = 0;
		const cycle = await runJev(
			{ goal: "Do the thing", maxSteps: 20 },
			{
				page: () => page,
				policy: {
					async choose(observation) {
						turn++;
						await page.evaluate(
							(state) => {
								document.getElementById("marker")!.textContent = state;
							},
							turn % 2 === 0 ? "alpha" : "beta",
						);
						return clickLabel(observation, "Alpha");
					},
					async text() {
						return "unused";
					},
				},
			},
		);
		assert.equal(cycle.status, "blocked");
		assert.match(cycle.message, /already visited/);
		assert.ok(
			cycle.steps.length < 10,
			`stopped early, took ${cycle.steps.length} of 20 steps`,
		);

		// A policy that keeps producing states it has never seen is a sweep, not a loop.
		await page.setContent("<button>Next</button><p id=\"n\">0</p>");
		let tick = 0;
		const sweep = await runJev(
			{ goal: "Walk through the pages", maxSteps: 20 },
			{
				page: () => page,
				policy: {
					async choose(observation) {
						tick++;
						if (tick > 5) return { operation: "DONE", probability: 1 };
						await page.evaluate(
							(value) => {
								document.getElementById("n")!.textContent = String(value);
							},
							tick,
						);
						return clickLabel(observation, "Next");
					},
					async text() {
						return "unused";
					},
				},
			},
		);
		assert.equal(sweep.status, "done_unverified");
		assert.equal(sweep.failure, undefined);
		assert.equal(sweep.steps.filter((s) => s.status === "executed").length, 5);
	} finally {
		await browser.close();
	}
});
