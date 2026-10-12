import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import {
	acquireLock,
	agentDirFromEnv,
	claimLock,
	clearFailure,
	compareVersions,
	isDue,
	isEmbedded,
	LOCK_DIR,
	lockState,
	PI_PACKAGE_NAME,
	readState,
	recordFailure,
	releaseLock,
	STALE_LOCK_MS,
	systemPi,
	throttleMs,
	verify,
	writeState,
} from "../index.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pisu-test-"));
const H = 3_600_000;

/** A fake Pi install: <root>/lib/pi-coding-agent with a package.json and an executable dist/cli.js. */
const makePi = (root: string, version = "1.1.0") => {
	const pkg = join(root, "lib", "pi-coding-agent");
	mkdirSync(join(pkg, "dist"), { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: PI_PACKAGE_NAME, version }));
	writeFileSync(join(pkg, "dist", "cli.js"), "#!/bin/sh\n");
	chmodSync(join(pkg, "dist", "cli.js"), 0o755);
	return pkg;
};

test("compareVersions orders releases and prereleases like semver", () => {
	const sorted = ["0.9.9", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "1.10.0", "2.0.0"];
	for (let i = 0; i < sorted.length; i++)
		for (let j = 0; j < sorted.length; j++)
			assert.equal(Math.sign(compareVersions(sorted[i], sorted[j])), Math.sign(i - j), `${sorted[i]} vs ${sorted[j]}`);
	assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
	assert.equal(compareVersions("1.2.3+build.5", "1.2.3"), 0);
	assert.equal(compareVersions("1.2", "1.2.0"), 0);
});

test("agentDirFromEnv respects PI_CODING_AGENT_DIR", () => {
	assert.equal(agentDirFromEnv({ PI_CODING_AGENT_DIR: "/x/y" }), "/x/y");
	assert.match(agentDirFromEnv({}), /\.pi\/agent$/);
	assert.match(agentDirFromEnv({ PI_CODING_AGENT_DIR: "~/a" }), /\/a$/);
});

test("throttle window defaults to 6h and is configurable", () => {
	assert.equal(throttleMs({}), 6 * H);
	assert.equal(throttleMs({ PI_SILENT_UPDATE_INTERVAL_HOURS: "1.5" }), 1.5 * H);
	assert.equal(throttleMs({ PI_SILENT_UPDATE_INTERVAL_HOURS: "0" }), 0);
	assert.equal(throttleMs({ PI_SILENT_UPDATE_INTERVAL_HOURS: "junk" }), 6 * H);
	assert.equal(throttleMs({ PI_SILENT_UPDATE_INTERVAL_HOURS: "-1" }), 6 * H);
});

test("isDue: only once per window, unless forced; a clock jump back re-checks", () => {
	const now = 100 * H;
	assert.equal(isDue({}, now, 6 * H), true);
	assert.equal(isDue({ lastCheck: now - H }, now, 6 * H), false);
	assert.equal(isDue({ lastCheck: now - 6 * H }, now, 6 * H), true);
	assert.equal(isDue({ lastCheck: now - H }, now, 6 * H, true), true);
	assert.equal(isDue({ lastCheck: now + H }, now, 6 * H), true);
});

test("state file: missing or corrupt reads as empty; writes merge and drop undefined", () => {
	const dir = tmp();
	assert.deepEqual(readState(dir), {});
	writeFileSync(join(dir, "silent-update.json"), "{not json");
	assert.deepEqual(readState(dir), {});
	writeState(dir, { lastCheck: 1 });
	writeState(dir, { lastResult: "up to date" });
	assert.deepEqual(readState(dir), { lastCheck: 1, lastResult: "up to date" });
	assert.deepEqual(readdirSync(dir), ["silent-update.json"], "no temp files left");
	const nested = join(dir, "not", "yet");
	writeState(nested, { lastCheck: 2 });
	assert.equal(readState(nested).lastCheck, 2);
});

test("failures are recorded until a success clears them", () => {
	const dir = tmp();
	writeState(dir, { lastCheck: 5 });
	recordFailure(dir, ["`pi update --all` exited 1"], 42);
	assert.deepEqual(readState(dir), {
		lastCheck: 5,
		failures: ["`pi update --all` exited 1"],
		failedAt: 42,
		lastResult: "failed: `pi update --all` exited 1",
	});
	clearFailure(dir, "updated x 1.0.0 -> 1.1.0");
	assert.deepEqual(readState(dir), { lastCheck: 5, lastResult: "updated x 1.0.0 -> 1.1.0" });
});

test("lock: busy while held, finished once the job wrote exit, stale after 1h, claim is exclusive", () => {
	const dir = tmp();
	assert.equal(lockState(dir), "absent");
	assert.equal(acquireLock(dir), "acquired");
	assert.equal(acquireLock(dir), "busy");
	const now = Date.now();
	assert.equal(lockState(dir, now + STALE_LOCK_MS + 1000), "stale");
	writeFileSync(join(dir, LOCK_DIR, "exit"), "0\n");
	assert.equal(acquireLock(dir), "finished");
	const a = claimLock(dir);
	const b = claimLock(dir);
	assert.ok(a && existsSync(join(a, "exit")));
	assert.equal(b, undefined);
	assert.equal(lockState(dir), "absent");
	assert.equal(acquireLock(dir), "acquired");
	releaseLock(dir);
	assert.equal(lockState(dir), "absent");
});

test("lock: an old lock on disk is reported stale", () => {
	const dir = tmp();
	mkdirSync(join(dir, LOCK_DIR));
	const old = (Date.now() - STALE_LOCK_MS - 60_000) / 1000;
	utimesSync(join(dir, LOCK_DIR), old, old);
	assert.equal(acquireLock(dir), "stale");
});

test("lock: exactly one of many concurrent processes acquires it", async () => {
	const dir = tmp();
	const url = new URL("../index.ts", import.meta.url).href;
	const code = `const m = await import(${JSON.stringify(url)}); const { acquireLock } = m.acquireLock ? m : m.default; await new Promise((r) => setTimeout(r, 300 - (Date.now() % 300))); process.stdout.write(acquireLock(${JSON.stringify(dir)}));`;
	const runs = Array.from({ length: 8 }, () => {
		const child = spawn(process.execPath, ["--import", "jiti/register", "--input-type=module", "-e", code]);
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		return new Promise<string>((resolve) => child.on("close", () => resolve(out)));
	});
	const results = await Promise.all(runs);
	assert.equal(results.filter((r) => r === "acquired").length, 1, results.join(","));
	assert.equal(results.filter((r) => r === "busy").length, 7, results.join(","));
});

test("verify: anything still older than the target is a failure", () => {
	const items = [
		{ name: "pi", kind: "pi" as const, from: "1.1.0", to: "1.2.0", path: "/p" },
		{ name: "pkg", kind: "npm" as const, from: "0.1.0", to: "0.2.0", path: "/n" },
		{ name: "gone", kind: "npm" as const, from: "1.0.0", to: "2.0.0", path: "/g" },
		{ name: "github.com/a/b", kind: "git" as const, from: "aaaaaaa", to: "b".repeat(40), path: "/git" },
	];
	const installed: Record<string, string> = { "/p": "1.2.0", "/n": "0.1.0", "/git": "c".repeat(40) };
	assert.deepEqual(verify({ items, command: "x" }, (i) => installed[i.path]), [
		"pkg is 0.1.0, expected 0.2.0",
		"gone is missing, expected 2.0.0",
		`github.com/a/b is ${"c".repeat(40)}, expected ${"b".repeat(40)}`,
	]);
	installed["/n"] = "0.3.0";
	installed["/g"] = "2.0.0";
	installed["/git"] = "b".repeat(40);
	assert.deepEqual(verify({ items, command: "x" }, (i) => installed[i.path]), []);
});

test("systemPi: finds the Pi package behind a symlinked `pi` on PATH", () => {
	const root = tmp();
	const pkg = makePi(root);
	mkdirSync(join(root, "bin"));
	symlinkSync(join(pkg, "dist", "cli.js"), join(root, "bin", "pi"));
	const env = { PATH: [join(root, "bin"), "/definitely/not/on/path"].join(delimiter) };
	assert.deepEqual(systemPi(env, "linux"), { bin: join(realpathSync(pkg), "dist", "cli.js"), dir: realpathSync(pkg) });
});

test("systemPi: shell PATH order — the first executable `pi` is the one the command runs, even when it is not a Pi install", () => {
	const root = tmp();
	mkdirSync(join(root, "bin"), { recursive: true });
	writeFileSync(join(root, "bin", "pi"), "#!/bin/sh\nexec not-pi\n");
	chmodSync(join(root, "bin", "pi"), 0o755);
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "not-pi", bin: { pi: "bin/pi" } }));
	const pkg = makePi(root);
	symlinkSync(join(pkg, "dist", "cli.js"), join(root, "lib", "pi"));
	// `pi update --all` runs the bare `pi`, so the impostor first on PATH is what the shell runs;
	// the later real Pi is never targeted, and no Pi package root can be resolved from the impostor.
	const env = { PATH: [join(root, "bin"), join(root, "lib")].join(delimiter) };
	assert.deepEqual(systemPi(env, "linux"), { bin: realpathSync(join(root, "bin", "pi")) });
	// With the real Pi first on PATH, it resolves to its package root as usual.
	assert.deepEqual(systemPi({ PATH: join(root, "lib") }, "linux"), { bin: join(realpathSync(pkg), "dist", "cli.js"), dir: realpathSync(pkg) });
});

test("systemPi: a present `pi` with no Pi package above it (shim or wrapper) resolves `bin` only", () => {
	const root = tmp();
	mkdirSync(join(root, "bin"), { recursive: true });
	writeFileSync(join(root, "bin", "pi"), "#!/bin/sh\n");
	chmodSync(join(root, "bin", "pi"), 0o755);
	// A non-Pi package.json above the shim (pnpm/volta/asdf style) must not resolve as the Pi root.
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "shim-host" }));
	assert.deepEqual(systemPi({ PATH: join(root, "bin") }, "linux"), { bin: realpathSync(join(root, "bin", "pi")) });
});

test("systemPi: no `pi` anywhere on PATH returns undefined", () => {
	assert.equal(systemPi({ PATH: join(tmp(), "missing-bin") }, "linux"), undefined);
	assert.equal(systemPi({ PATH: "" }, "linux"), undefined);
});

test("isEmbedded: only a resolved system dir counts; a custom command is trusted", () => {
	assert.equal(isEmbedded("/app/pi", {}, "/app/pi"), false);
	assert.equal(isEmbedded("/app/pi", {}, "/system/pi"), true);
	// A `pi` present but unresolvable (shim) is NOT embedded: the running copy is checked as before.
	assert.equal(isEmbedded("/app/pi", {}, undefined), false);
	assert.equal(isEmbedded("/app/pi", { PI_SILENT_UPDATE_CMD: "my update cmd" }, "/system/pi"), false);
});
