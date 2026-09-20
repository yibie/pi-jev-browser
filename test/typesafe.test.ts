import assert from "node:assert/strict";
import test from "node:test";
import type { Observation } from "../src/jev-browser.ts";
import { createTypesafePolicy, parseChoiceAnswer, TYPESAFE_ENDPOINT } from "../src/typesafe.ts";

const observation: Observation = {
	url: "https://example.test",
	title: "Search",
	text: "Search",
	scrollUp: false,
	scrollDown: true,
	targets: [
		{ id: "1", operation: "TYPE_TEXT", label: "Query", value: "" },
		{ id: "2", operation: "CLICK", label: "Search", value: "" },
	],
};
const text = async () => '{"text":"unused"}';
const offered = ["WAIT", "DONE", "CLICK:2"];
const answer = (choice: string, probabilities?: Record<string, unknown>) => ({
	answers: {
		action: { type: "choice", choice, ...(probabilities ? { probabilities } : {}), confidence: 0.9 },
	},
});

test("only an unmappable answer is fatal; a doubtful distribution degrades instead", () => {
	assert.deepEqual(
		parseChoiceAnswer(answer("CLICK:2", { WAIT: 0, DONE: 0.2, "CLICK:2": 0.8 }), offered),
		{ choice: "CLICK:2", probability: 0.8, confidence: 0.9 },
	);
	// An unoffered choice would make the loop act on something it cannot map.
	assert.throws(
		() => parseChoiceAnswer(answer("CLICK:99", { WAIT: 0, DONE: 0.2, "CLICK:2": 0.8 }), offered),
		/unoffered option/,
	);
	assert.throws(() => parseChoiceAnswer({}, offered), /no answers/);
	assert.throws(
		() => parseChoiceAnswer({ answers: { action: { type: "score" } } }, offered),
		/with type "score"/,
	);

	// Everything below is usable enough to keep going: killing a run that has
	// already clicked things because a distribution looked odd is worse than
	// reporting the choice with its probability marked unknown.
	// A partial distribution still names a valid choice.
	assert.deepEqual(parseChoiceAnswer(answer("DONE", { DONE: 1 }), offered), {
		choice: "DONE",
		probability: 1,
		confidence: 0.9,
	});
	// A distribution that does not sum to 1 is reported as-is.
	assert.equal(
		parseChoiceAnswer(answer("DONE", { WAIT: 0.5, DONE: 0.5, "CLICK:2": 0.5 }), offered).probability,
		0.5,
	);
	// A selection that is not the argmax still runs.
	assert.equal(
		parseChoiceAnswer(answer("DONE", { WAIT: 0.6, DONE: 0.2, "CLICK:2": 0.2 }), offered).probability,
		0.2,
	);
	// The selected option's own value has to be a usable probability.
	assert.equal(
		parseChoiceAnswer(answer("DONE", { WAIT: 0, DONE: 1.4 }), offered).probability,
		undefined,
	);
	assert.equal(parseChoiceAnswer(answer("DONE", { DONE: "half" }), offered).probability, undefined);
	// Probabilities are optional; the choice alone is still usable.
	assert.deepEqual(
		parseChoiceAnswer({ answers: { action: { type: "choice", choice: "DONE" } } }, offered),
		{ choice: "DONE", probability: undefined, confidence: undefined },
	);
});

test("posts the same questions to the TypeSafe API and maps the answer back", async () => {
	let seen: { url: string; init: RequestInit } | undefined;
	const policy = createTypesafePolicy({
		apiKey: "offline-test-key",
		text,
		fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
			seen = { url: String(url), init: init ?? {} };
			const body = JSON.parse(String(init?.body));
			const choices = Object.keys(body.questions.action.criteria);
			return Response.json({
				model: body.model,
				answers: {
					action: {
						type: "choice",
						choice: "CLICK:2",
						probabilities: Object.fromEntries(
							choices.map((entry: string) => [entry, entry === "CLICK:2" ? 1 : 0]),
						),
						confidence: 0.77,
					},
				},
				usage: { input_tokens: 10, output_tokens: 1 },
			});
		}) as unknown as typeof fetch,
	});
	const decision = await policy.choose(observation, "Search for cats", [], new AbortController().signal);
	assert.equal(seen?.url, TYPESAFE_ENDPOINT);
	assert.equal(seen?.init.method, "POST");
	const headers = new Headers(seen?.init.headers);
	assert.equal(headers.get("authorization"), "Bearer offline-test-key");
	const body = JSON.parse(String(seen?.init.body));
	assert.equal(body.model, "jev-latest");
	assert.deepEqual(Object.keys(body.questions), ["action"]);
	assert.equal(typeof body.state, "string");
	assert.match(body.state, /"recentActions":\[\]/);
	assert.equal(decision.operation, "CLICK");
	assert.equal(decision.target?.id, "2");
	assert.equal(decision.probability, 1);
	assert.equal(decision.providerConfidence, 0.77);
});

test("surfaces the status code and the body so the loop can classify throttling", async () => {
	const policy = createTypesafePolicy({
		apiKey: "offline-test-key",
		text,
		fetchImpl: (async () =>
			new Response("rate limited", { status: 429 })) as unknown as typeof fetch,
	});
	await assert.rejects(
		policy.choose(observation, "Search", [], new AbortController().signal),
		(error: Error & { statusCode?: number }) => {
			assert.equal(error.statusCode, 429);
			assert.match(error.message, /429/);
			return true;
		},
	);
});
