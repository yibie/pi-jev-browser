import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readTypesafeCredentials } from "../src/credentials.ts";

test("credential file handles JSON syntax, precedence, reloads and missing keys", () => {
	const directory = mkdtempSync(join(tmpdir(), "jev-credentials-"));
	const path = join(directory, "config.json");
	try {
		assert.throws(() => readTypesafeCredentials({ path, env: {} }), /TYPESAFE_API_KEY/);
		writeFileSync(
			path,
			JSON.stringify({
				typesafe: { apiKey: "file-test-key", model: "jev-latest" },
			}),
			{ mode: 0o600 },
		);
		assert.deepEqual(readTypesafeCredentials({ path, env: {} }), {
			apiKey: "file-test-key",
			model: "jev-latest",
		});
		assert.deepEqual(
			readTypesafeCredentials({
				path,
				env: { TYPESAFE_API_KEY: "env-test-key", TYPESAFE_MODEL: "other-model" },
			}),
			{ apiKey: "env-test-key", model: "other-model" },
		);
		// A blank environment value must not shadow a configured file value.
		assert.equal(
			readTypesafeCredentials({ path, env: { TYPESAFE_API_KEY: "  " } }).apiKey,
			"file-test-key",
		);
		// The model falls back to the current default when nothing sets it.
		writeFileSync(path, JSON.stringify({ typesafe: { apiKey: "changed-test-key" } }));
		assert.deepEqual(readTypesafeCredentials({ path, env: {} }), {
			apiKey: "changed-test-key",
			model: "jev-latest",
		});
		writeFileSync(path, "{}");
		assert.throws(() => readTypesafeCredentials({ path, env: {} }), /TYPESAFE_API_KEY/);
		writeFileSync(path, "{invalid");
		assert.throws(() => readTypesafeCredentials({ path, env: {} }), /JSON syntax/);
		assert.throws(
			() => readTypesafeCredentials({ path: directory, env: {} }),
			/Cannot read/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
