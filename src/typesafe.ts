import type { Observation, ObservedTarget } from "./jev-browser.ts";
import { buildQuestions, type Decision, type JevPolicy, parseText } from "./jev-model.ts";
import { buildTextPrompt, type ModelCall, TEXT_SYSTEM } from "./pi-model.ts";

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_TYPESAFE_MODEL = "jev-latest";

export interface TypesafeChoice {
	choice: string;
	probability?: number;
	confidence?: number;
}

/**
 * The TypeSafe API returns a choice, a probability for every offered option, and
 * a confidence for the selected one. Only the choice is load-bearing: an answer
 * that names no offered option tells the loop nothing, so that is an error. A
 * distribution the loop cannot fully trust must never kill a run that has
already taken actions, so anything else about it degrades to "probability
 * unknown" instead.
 */
export function parseChoiceAnswer(
	value: unknown,
	valid: readonly string[],
): TypesafeChoice {
	const answers = (value as { answers?: unknown } | null | undefined)?.answers;
	if (!answers || typeof answers !== "object")
		throw new Error("TypeSafe returned no answers.");
	const action = (answers as Record<string, unknown>).action;
	if (!action || typeof action !== "object")
		throw new Error("TypeSafe returned no answer for the action question.");
	const { type, choice, probabilities, confidence } = action as {
		type?: unknown;
		choice?: unknown;
		probabilities?: unknown;
		confidence?: unknown;
	};
	if (type !== "choice")
		throw new Error(
			`TypeSafe answered the action question with type ${describe(type)}.`,
		);
	if (typeof choice !== "string" || !valid.includes(choice))
		throw new Error(
			`TypeSafe selected an unoffered option (${describe(choice)}). Offered: ${valid.slice(0, 10).join(", ")}${valid.length > 10 ? ", …" : ""}.`,
		);
	return {
		choice,
		probability: reportedProbability(probabilities, choice),
		confidence:
			typeof confidence === "number" && Number.isFinite(confidence)
				? confidence
				: undefined,
	};
}

/** The selected option's own probability, if it is a usable number. */
function reportedProbability(value: unknown, choice: string): number | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const reported = (value as Record<string, unknown>)[choice];
	return typeof reported === "number" &&
		Number.isFinite(reported) &&
		reported >= 0 &&
		reported <= 1
		? reported
		: undefined;
}

function describe(value: unknown) {
	return (JSON.stringify(value) ?? String(value)).slice(0, 60);
}

/**
 * Direct TypeSafe transport: no gateway, no second vendor. Jev generates no
 * text, so field values still come from a model — the one pi has configured. */
export function createTypesafePolicy(options: {
	apiKey: string;
	model?: string;
	text: ModelCall;
	fetchImpl?: typeof fetch;
}): JevPolicy {
	const model = options.model ?? DEFAULT_TYPESAFE_MODEL;
	const request = options.fetchImpl ?? fetch;
	return {
		async choose(observation, goal, history, signal): Promise<Decision> {
			const questions = buildQuestions(observation, goal);
			const response = await request(TYPESAFE_ENDPOINT, {
				method: "POST",
				headers: {
					authorization: `Bearer ${options.apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					state: JSON.stringify({
						page: observation,
						recentActions: history.slice(-10),
					}),
					model,
					questions,
				}),
				signal,
			});
			if (!response.ok) {
				// Keep the body out of the message only when it is unreadable; the
				// status code is what the loop classifies.
				const detail = await response.text().catch(() => "");
				throw Object.assign(
					new Error(
						`TypeSafe request failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
					),
					{ statusCode: response.status },
				);
			}
			const { choice, probability, confidence } = parseChoiceAnswer(
				await response.json(),
				Object.keys(questions.action.criteria),
			);
			const target: ObservedTarget | undefined = observation.targets.find(
				(entry) => `${entry.operation}:${entry.id}` === choice,
			);
			return {
				operation: target?.operation ?? choice,
				target,
				probability,
				providerConfidence: confidence,
			};
		},
		async text(observation, goal, target, history, signal) {
			const answer = await options.text({
				system: TEXT_SYSTEM,
				prompt: buildTextPrompt(observation, goal, target, history),
				signal,
			});
			return parseText(answer);
		},
	};
}
