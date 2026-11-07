// Thin wrappers around child_process. No shell is ever involved.
import { spawnSync, spawn } from "node:child_process";

export class CommandError extends Error {
  constructor(cmd, args, result) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-4).join("\n");
    super(`${cmd} ${args.join(" ")} failed (${result.status ?? result.signal ?? result.error?.code})${detail ? `: ${detail}` : ""}`);
    this.cmd = cmd;
    this.args = args;
    this.status = result.status;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

/** Run a command, capture stdout/stderr. Throws CommandError unless `allowFail`. */
export function run(cmd, args, { cwd, timeout = 30_000, allowFail = false, env, input } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    timeout,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!allowFail && (result.error || result.status !== 0)) {
    throw new CommandError(cmd, args, result);
  }
  return result;
}

/** Run a command and parse stdout as JSON. Throws on failure or bad JSON. */
export function runJson(cmd, args, opts) {
  const result = run(cmd, args, opts);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new CommandError(cmd, args, { ...result, stderr: `invalid JSON on stdout: ${result.stdout.slice(0, 200)}` });
  }
}

/**
 * Run a command attached to the terminal (stdin + stderr inherited) so it can
 * prompt the user, while stdout is captured. Used for `wt` calls that may ask
 * to approve project hooks.
 */
export function runInteractive(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["inherit", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", (error) => resolve({ status: null, stdout, error }));
    child.on("close", (status, signal) => resolve({ status, signal, stdout }));
  });
}

/** Async capture, for slow calls the picker runs while it stays responsive. */
export function runAsync(cmd, args, { cwd, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new CommandError(cmd, args, { error, stdout, stderr }));
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      if (status === 0) resolve({ stdout, stderr, status });
      else reject(new CommandError(cmd, args, { status, signal, stdout, stderr }));
    });
  });
}

export function which(cmd) {
  const result = spawnSync("sh", ["-c", 'command -v "$1"', "sh", cmd], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}
