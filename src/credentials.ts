import { CONFIG_PATH, readConfigFile } from "./config.ts";

/**
 * Credentials for the direct TypeSafe API. Read per run without mutating
 * process.env or exposing them to the browser process, which gets `env: {}`.
 */
export function readTypesafeCredentials(
	options: { path?: string; env?: NodeJS.ProcessEnv } = {},
) {
	const path = options.path ?? CONFIG_PATH;
	const env = options.env ?? process.env;
	const raw = readConfigFile(path);
	const typesafe = raw.typesafe as
		| { apiKey?: unknown; model?: unknown }
		| undefined;
	const value = (input: unknown) =>
		typeof input === "string" ? input.trim() : "";
	const apiKey = value(env.TYPESAFE_API_KEY) || value(typesafe?.apiKey);
	if (!apiKey)
		throw new Error(
			`policy "typesafe" requires TYPESAFE_API_KEY in the pi process environment or typesafe.apiKey in ${path}. Get a key at https://console.typesafe.ai/keys`,
		);
	const model =
		value(env.TYPESAFE_MODEL) || value(typesafe?.model) || "jev-latest";
	return { apiKey, model };
}
