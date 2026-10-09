// pi-silent-update: keep Pi and its packages current without Pi's update popups.
// One file, no runtime dependencies. Pure helpers are exported for the tests.
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_FILE = "silent-update.json";
export const LOCK_DIR = "silent-update.lock";
export const STALE_LOCK_MS = 60 * 60 * 1000;
const JOB_TIMEOUT_S = 15 * 60;
const NET_TIMEOUT_MS = 10_000;
const STATUS_KEY = "silent-update";

export interface State {
	lastCheck?: number;
	lastAttempt?: number;
	lastResult?: string;
	failures?: string[];
	failedAt?: number;
}
export interface Item {
	name: string;
	kind: "pi" | "npm" | "git";
	from: string;
	to: string;
	path: string;
}
export interface Plan {
	items: Item[];
	command: string;
}

// ---------- pure helpers ----------

/** Semver-style compare (prerelease aware, build metadata ignored). Returns <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) => {
		const s = v.trim().replace(/^v/, "").split("+")[0];
		const i = s.indexOf("-");
		return { core: (i < 0 ? s : s.slice(0, i)).split("."), pre: i < 0 ? [] : s.slice(i + 1).split(".") };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) {
		const d = (Number(x.core[i]) || 0) - (Number(y.core[i]) || 0);
		if (d) return Math.sign(d);
	}
	// A release sorts after its prereleases.
	if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i];
		const q = y.pre[i];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		const pn = /^\d+$/.test(p);
		const qn = /^\d+$/.test(q);
		if (pn && qn && Number(p) !== Number(q)) return Math.sign(Number(p) - Number(q));
		if (pn !== qn) return pn ? -1 : 1;
		if (p !== q) return p < q ? -1 : 1;
	}
	return 0;
}

export function agentDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
	const d = env.PI_CODING_AGENT_DIR;
	if (!d) return join(homedir(), ".pi", "agent");
	return d === "~" ? homedir() : d.startsWith("~/") ? join(homedir(), d.slice(2)) : d;
}

export function throttleMs(env: NodeJS.ProcessEnv = process.env): number {
	const h = Number(env.PI_SILENT_UPDATE_INTERVAL_HOURS);
	return (env.PI_SILENT_UPDATE_INTERVAL_HOURS && Number.isFinite(h) && h >= 0 ? h : 6) * 3_600_000;
}

export function readState(dir: string): State {
	try {
		return JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")) as State;
	} catch {
		return {};
	}
}

export function writeState(dir: string, patch: Partial<State>): State {
	const next = { ...readState(dir), ...patch };
	for (const k of Object.keys(next) as (keyof State)[]) if (next[k] === undefined) delete next[k];
	const tmp = join(dir, `${STATE_FILE}.${process.pid}.tmp`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(tmp, `${JSON.stringify(next, null, "\t")}\n`);
	renameSync(tmp, join(dir, STATE_FILE));
	return next;
}

/** Throttle: a check is due when forced or when the window since the last check (by any session) elapsed. */
export function isDue(state: State, now: number, windowMs: number, force = false): boolean {
	return force || now - (state.lastCheck ?? 0) >= windowMs || (state.lastCheck ?? 0) > now;
}

export function recordFailure(dir: string, failures: string[], now = Date.now()): State {
	return writeState(dir, { failures, failedAt: now, lastResult: `failed: ${failures.join("; ")}` });
}

export function clearFailure(dir: string, result: string): State {
	return writeState(dir, { failures: undefined, failedAt: undefined, lastResult: result });
}

export type LockResult = "acquired" | "busy" | "finished" | "stale";

/** Per-machine lock via atomic mkdir. The detached job writes `exit` into it when done. */
export function acquireLock(dir: string, now = Date.now()): LockResult | "absent" {
	const lock = join(dir, LOCK_DIR);
	try {
		mkdirSync(lock);
		writeFileSync(join(lock, "owner"), `${process.pid} ${now}\n`);
		return "acquired";
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
	}
	return lockState(dir, now);
}

/** State of an existing lock: "finished" (result waiting), "stale" (older than 1h, no result), "busy" or absent. */
export function lockState(dir: string, now = Date.now()): LockResult | "absent" {
	const lock = join(dir, LOCK_DIR);
	try {
		const age = now - statSync(lock).mtimeMs;
		if (existsSync(join(lock, "exit"))) return "finished";
		return age > STALE_LOCK_MS ? "stale" : "busy";
	} catch {
		return "absent";
	}
}

export function releaseLock(dir: string): void {
	rmSync(join(dir, LOCK_DIR), { recursive: true, force: true });
}

/** Atomically take ownership of a finished (or broken) lock so only one session finalizes it. */
export function claimLock(dir: string): string | undefined {
	const claimed = join(dir, `${LOCK_DIR}.done.${process.pid}.${Date.now()}`);
	try {
		renameSync(join(dir, LOCK_DIR), claimed);
		return claimed;
	} catch {
		return undefined;
	}
}

export function summarize(items: Item[]): string {
	return items.map((i) => `${i.name} ${i.from} -> ${i.to}`).join(", ");
}

/** Compare the plan against what is installed now. Returns the items that are still older than the target. */
export function verify(plan: Plan, installed: (item: Item) => string | undefined): string[] {
	const bad: string[] = [];
	for (const item of plan.items) {
		const now = installed(item);
		const ok = now !== undefined && (item.kind === "git" ? now === item.to : compareVersions(now, item.to) >= 0);
		if (!ok) bad.push(`${item.name} is ${now ?? "missing"}, expected ${item.to}`);
	}
	return bad;
}

// ---------- Pi integration ----------

type Ctx = { cwd: string; hasUI: boolean; ui: { notify(m: string, t?: "info" | "warning" | "error"): void; setStatus(k: string, t: string | undefined): void } };
type Pc = typeof import("@earendil-works/pi-coding-agent");

const run = (cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}) =>
	new Promise<string>((resolve, reject) =>
		execFile(cmd, args, { ...opts, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, out, errOut) =>
			err ? reject(new Error((errOut || err.message).trim().split("\n").pop())) : resolve(out.trim()),
		),
	);

async function getJson(url: string, accept = "application/json"): Promise<any> {
	const res = await fetch(url, { headers: { accept }, signal: AbortSignal.timeout(NET_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
	return res.json();
}

const readVersion = (dir: string) => {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version as string;
	} catch {
		return undefined;
	}
};

async function gitTarget(path: string): Promise<{ head: string; remote: string }> {
	const head = await run("git", ["rev-parse", "HEAD"], { cwd: path, timeout: NET_TIMEOUT_MS });
	const upstream = await run("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: path }).catch(() => "");
	const ref = upstream.startsWith("origin/") ? `refs/heads/${upstream.slice(7)}` : "HEAD";
	const out = await run("git", ["ls-remote", "origin", ref], { cwd: path, timeout: NET_TIMEOUT_MS });
	const remote = out.match(/^([0-9a-f]{40})\s/m)?.[1];
	if (!remote) throw new Error(`no remote head for ${ref}`);
	return { head, remote };
}

/** Find everything newer than what is installed, using Pi's own package rules. No npm processes. */
async function findUpdates(pc: Pc, cwd: string, agentDir: string): Promise<{ items: Item[]; errors: string[] }> {
	const items: Item[] = [];
	const errors: string[] = [];
	const checks: Promise<void>[] = [];
	const piDir = pc.getPackageDir();
	// Compare against the version on disk, so a session started before an update does not re-run it.
	const piNow = readVersion(piDir) ?? pc.VERSION;
	checks.push(
		getJson("https://pi.dev/api/latest-version").then((d) => {
			if (typeof d?.version !== "string") throw new Error("pi.dev returned no version");
			if (compareVersions(d.version, piNow) > 0) items.push({ name: "pi", kind: "pi", from: piNow, to: d.version, path: piDir });
		}, (e) => void errors.push(`checking pi: ${e.message}`)),
	);
	const trusted = new pc.ProjectTrustStore(agentDir).get(cwd) === true; // same rule as `pi update`
	const settingsManager = pc.SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
	const pm = new pc.DefaultPackageManager({ cwd, agentDir, settingsManager }) as any;
	if (typeof pm.parseSource !== "function") throw new Error("unsupported Pi version (DefaultPackageManager.parseSource missing)");
	const registry = (process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
	const configured = pm.listConfiguredPackages() as { source: string; scope: string; installedPath?: string }[];
	const seen = new Set<string>();
	for (const p of [...configured.filter((c) => c.scope === "project"), ...configured.filter((c) => c.scope !== "project")]) {
		const src = pm.parseSource(p.source);
		const key = src.type === "npm" ? src.name : p.source;
		if (seen.has(key) || src.type === "local" || src.pinned || !p.installedPath) continue;
		seen.add(key);
		const path = p.installedPath;
		if (src.type === "npm") {
			const installed = readVersion(path);
			if (!installed) continue;
			const name = encodeURIComponent(src.name).replace(/^%40/, "@");
			const latest = src.range
				? getJson(`${registry}/${name}`, "application/vnd.npm.install-v1+json").then((d) =>
						createRequire(join(piDir, "package.json"))("semver").maxSatisfying(Object.keys(d.versions ?? {}), src.range),
					)
				: getJson(`${registry}/${name}/${encodeURIComponent(src.version || "latest")}`).then((d) => d?.version);
			checks.push(
				latest.then((to) => {
					if (typeof to !== "string") throw new Error("registry returned no version");
					if (compareVersions(to, installed) > 0) items.push({ name: src.name, kind: "npm", from: installed, to, path });
				}, (e) => void errors.push(`checking ${src.name}: ${e.message}`)),
			);
		} else {
			const label = `${src.host}/${src.path}`;
			checks.push(
				gitTarget(path).then(({ head, remote }) => {
					if (head !== remote) items.push({ name: label, kind: "git", from: head.slice(0, 7), to: remote, path });
				}, (e) => void errors.push(`checking ${label}: ${e.message}`)),
			);
		}
	}
	await Promise.all(checks);
	return { items, errors };
}

function installedNow(item: Item): string | undefined {
	if (item.kind !== "git") return readVersion(item.path);
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: item.path, encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}

/** Run the update outside the session: a transient systemd user unit when available, else a detached child. */
async function startJob(lock: string, cwd: string, command: string): Promise<void> {
	const script =
		'T=; command -v timeout >/dev/null 2>&1 && T="timeout -k 10 $3"; cd "$1" && $T sh -c "$2" >"$4/log" 2>&1; ' +
		'echo $? >"$4/exit.tmp"; mv "$4/exit.tmp" "$4/exit"';
	const args = ["-c", script, "pi-silent-update", cwd, command, String(JOB_TIMEOUT_S), lock];
	const env = Object.keys(process.env).filter((k) => /^(PATH|HOME|PI_.*|npm_config_.*|NPM_CONFIG_.*|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy|NODE_.*)$/.test(k));
	if (process.platform === "linux") {
		const unit = ["--user", "--collect", "--quiet", `--unit=pi-silent-update-${Date.now()}`, ...env.map((k) => `--setenv=${k}`), "--", "/bin/sh"];
		if (await run("systemd-run", [...unit, ...args], { timeout: NET_TIMEOUT_MS }).then(() => true, () => false)) return;
	}
	await new Promise<void>((resolve, reject) => {
		const child = spawn("/bin/sh", args, { cwd, detached: true, stdio: "ignore" });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

type Shared = { started?: boolean; ctx?: Ctx; pending: { msg: string; type: "info" | "warning" }[]; running?: Promise<void>; poll?: ReturnType<typeof setInterval> };

export default async function silentUpdate(pi: any) {
	// Pi runs its own update checks right after session_start; switch both popups off before that.
	process.env.PI_SKIP_VERSION_CHECK = "1";
	const pc: Pc = await import("@earendil-works/pi-coding-agent");
	(pc.InteractiveMode.prototype as any).checkForPackageUpdates = async () => [];

	const agentDir = pc.getAgentDir();
	const command = process.env.PI_SILENT_UPDATE_CMD || "pi update --all";
	const lockDir = join(agentDir, LOCK_DIR);
	// Pi re-runs extension factories on /new, /resume and /fork; keep one state per process.
	const g = globalThis as { __piSilentUpdate?: Shared };
	const sh: Shared = (g.__piSilentUpdate ??= { pending: [] });

	const say = (msg: string, type: "info" | "warning" = "info") => {
		try {
			if (sh.ctx?.hasUI) return sh.ctx.ui.notify(msg, type);
		} catch {}
		sh.pending.push({ msg, type });
	};
	const showFailure = () => {
		const { failures } = readState(agentDir);
		try {
			sh.ctx?.ui.setStatus(STATUS_KEY, failures?.length ? "⚠ update failed: /silent-update" : undefined);
		} catch {}
		if (failures?.length) say(`pi-silent-update failed: ${failures.join("; ")}. Run by hand: ${command}`, "warning");
	};
	const fail = (failures: string[]) => {
		const before = readState(agentDir).failures?.join("\n");
		recordFailure(agentDir, failures);
		// session_start already showed a recorded failure; only repeat it when it changed.
		if (sh.ctx && before !== failures.join("\n")) showFailure();
	};

	/** Read the result the detached job left in the lock, verify it, and report. Only one session wins the claim. */
	const finalize = () => {
		const claimed = claimLock(agentDir);
		if (!claimed) return;
		clearInterval(sh.poll);
		try {
			const plan = JSON.parse(readFileSync(join(claimed, "plan.json"), "utf8")) as Plan;
			const code = Number(readFileSync(join(claimed, "exit"), "utf8").trim());
			let log = "";
			try {
				log = readFileSync(join(claimed, "log"), "utf8").trim().split("\n").slice(-3).join(" | ");
			} catch {}
			const bad = verify(plan, installedNow);
			const problems: string[] = [];
			if (code === 124 || code === 137) problems.push(`\`${plan.command}\` timed out after ${JOB_TIMEOUT_S / 60} min`);
			else if (code !== 0) problems.push(`\`${plan.command}\` exited ${code}${log ? `: ${log}` : ""}`);
			if (bad.length) problems.push(`still outdated after update: ${bad.join(", ")}`);
			if (problems.length) return fail(problems);
			clearFailure(agentDir, `updated ${summarize(plan.items)}`);
			showFailure();
			say(`Updated ${summarize(plan.items)}; restart Pi to use it`);
		} catch (e) {
			fail([`could not read the update result: ${(e as Error).message}`]);
		} finally {
			rmSync(claimed, { recursive: true, force: true });
		}
	};

	/** Finish a lock left behind: report a waiting result, or break and report a lock older than 1h. */
	const settle = () => {
		const lock = lockState(agentDir);
		if (lock === "finished") return finalize();
		if (lock !== "stale") return;
		const claimed = claimLock(agentDir);
		if (!claimed) return;
		rmSync(claimed, { recursive: true, force: true });
		fail([`a previous update never finished (its lock was older than 1h and was removed)`]);
	};

	const check = async (force: boolean) => {
		if (process.env.PI_OFFLINE) return;
		settle();
		const state = readState(agentDir);
		const now = Date.now();
		if (!isDue(state, now, throttleMs(), force)) return;
		writeState(agentDir, { lastCheck: now });
		const { items, errors } = await findUpdates(pc, sh.ctx?.cwd ?? process.cwd(), agentDir);
		if (!items.length) {
			if (errors.length) return fail(errors);
			if (state.failures?.length && lockState(agentDir) === "absent") {
				clearFailure(agentDir, "up to date");
				showFailure();
				say("pi-silent-update: the earlier update problem is resolved; everything is up to date");
			} else writeState(agentDir, { lastResult: "up to date" });
			return;
		}
		let got = acquireLock(agentDir);
		if (got === "finished" || got === "stale") {
			settle();
			got = acquireLock(agentDir);
		}
		if (got !== "acquired") return; // another session is updating (or just did)
		// Another session may have updated between our check and the lock.
		if ((readState(agentDir).lastAttempt ?? 0) >= now) return releaseLock(agentDir);
		try {
			writeFileSync(join(lockDir, "plan.json"), JSON.stringify({ items, command } satisfies Plan));
			writeState(agentDir, { lastAttempt: Date.now() });
			await startJob(lockDir, sh.ctx?.cwd ?? process.cwd(), command);
		} catch (e) {
			releaseLock(agentDir);
			return fail([`could not start \`${command}\`: ${(e as Error).message}`]);
		}
		if (errors.length) fail(errors);
		clearInterval(sh.poll);
		sh.poll = setInterval(() => lockState(agentDir) === "finished" && finalize(), 2000);
		sh.poll.unref?.();
	};
	const start = (force: boolean) =>
		(sh.running ??= check(force)
			.catch((e) => fail([`update check failed: ${(e as Error).message}`]))
			.finally(() => (sh.running = undefined)));

	// Package commands such as `pi update` also load extensions but never start a session, so check on startup only.
	pi.on("session_start", (event: { reason?: string }, c: Ctx) => {
		sh.ctx = c;
		// Show what is recorded first; a check started below only reports what changed.
		for (const { msg, type } of sh.pending.splice(0)) say(msg, type);
		showFailure();
		if (event.reason === "startup" && !sh.started) {
			sh.started = true;
			void start(false);
		}
	});

	pi.registerCommand("silent-update", {
		description: "Check for Pi and package updates now (ignores the throttle) and show the state",
		handler: async (_args: string, c: Ctx) => {
			sh.ctx = c;
			await sh.running;
			await start(true);
			const s = readState(agentDir);
			const at = (t?: number) => (t ? new Date(t).toLocaleString() : "never");
			const lines = [
				`pi-silent-update - state in ${join(agentDir, STATE_FILE)}`,
				`last check: ${at(s.lastCheck)}; last update started: ${at(s.lastAttempt)}`,
				`last result: ${s.lastResult ?? "none"}`,
				lockState(agentDir) === "absent" ? "" : `update in progress (lock: ${lockDir})`,
				s.failures?.length ? `FAILING: ${s.failures.join("; ")}. Run by hand: ${command}` : "no failures recorded",
			];
			c.ui.notify(lines.filter(Boolean).join("\n"), s.failures?.length ? "warning" : "info");
		},
	});
}
