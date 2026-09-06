// What a relative HYDRA_ACP_HOME does to daemon discovery.
//
// hydraHome() resolves its override with path.resolve, so a RELATIVE
// HYDRA_ACP_HOME means "relative to this process's cwd". Two processes
// handed the identical env value therefore root themselves in two
// different directories if they were launched from different places —
// and an editor launching the shim uses the project directory as cwd,
// which is not where a human ran the daemon from.
//
// That produces issue #9's exact symptom without any platform bug being
// involved: the shim finds no pidfile, reports "daemon not running",
// autostarts a second daemon, that daemon cannot bind the port the first
// one holds, and the wait times out while a healthy daemon is listening
// the whole time.
//
// This does not assert that the resolution is wrong — resolving a
// relative path against cwd is what path.resolve is for. It asserts the
// failure is LEGIBLE: that the caller is told which home was searched and
// why the daemon it started died, rather than being handed a bare
// 15-second timeout.
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../core/paths.js";
import { writeServiceToken } from "../core/service-token.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const CLI_BUNDLE = path.join(REPO_ROOT, "dist", "cli.js");
const describeBuilt = existsSync(CLI_BUNDLE) ? describe : describe.skip;

const TOKEN = "hydra_token_0123456789abcdef0123456789abcdef";
// Both sides deliberately share a port so the second daemon collides
// with the first. That collision is the mechanism being reproduced.
const SHARED_PORT = 49_152 + Math.floor(Math.random() * 15_000);

// The relative value handed to both processes. Identical string, two
// different resolved directories.
const RELATIVE_HOME = "hydra-home";

const spawnedHomes: string[] = [];

function runCli(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BUNDLE, ...args], {
      cwd,
      env: { ...process.env, HYDRA_ACP_HOME: RELATIVE_HOME },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`hydra ${args.join(" ")} hung\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function seedHome(dir: string): Promise<void> {
  const home = path.join(dir, RELATIVE_HOME);
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(
    path.join(home, "config.json"),
    JSON.stringify({ daemon: { port: SHARED_PORT, logLevel: "error" } }),
    "utf8",
  );
  // writeServiceToken targets the ambient home, so write directly.
  await fsp.writeFile(path.join(home, "auth-token"), TOKEN, "utf8");
  spawnedHomes.push(home);
}

afterEach(async () => {
  for (const home of spawnedHomes.splice(0)) {
    const pidfile = path.join(home, "daemon.pid");
    try {
      const info = JSON.parse(readFileSync(pidfile, "utf8")) as { pid: number };
      process.kill(info.pid);
    } catch {
      // No daemon, or already gone.
    }
  }
  await new Promise((r) => setTimeout(r, 200));
});

describeBuilt("relative HYDRA_ACP_HOME across two working directories", () => {
  it("fails legibly rather than with a bare timeout", async () => {
    const base = paths.home();
    const dirA = path.join(base, "launched-from-a");
    const dirB = path.join(base, "launched-from-b");
    await fsp.mkdir(dirA, { recursive: true });
    await fsp.mkdir(dirB, { recursive: true });
    await seedHome(dirA);
    await seedHome(dirB);

    // A healthy daemon, rooted under dirA.
    const started = await runCli(["daemon", "start"], dirA, 60_000);
    expect(
      started.code,
      `daemon start failed: ${started.stdout}${started.stderr}`,
    ).toBe(0);
    expect(existsSync(path.join(dirA, RELATIVE_HOME, "daemon.pid"))).toBe(true);

    // Same env value, different cwd. This is the editor-vs-shell split.
    const shim = await runCli(["daemon", "status"], dirB, 60_000);

    // It legitimately does not see the other home's daemon...
    expect(shim.stdout).toContain("not running");

    // ...and the point of the test: starting one from here collides with
    // the daemon already holding the port, and the caller must be told
    // that rather than being left with an unexplained timeout.
    const collide = await runCli(["daemon", "start"], dirB, 90_000);
    expect(collide.code).not.toBe(0);
    const message = `${collide.stdout}${collide.stderr}`;
    expect(
      message,
      "a readiness timeout with no reason is exactly what #9 reports",
    ).toMatch(/EADDRINUSE|address already in use|daemon exited during startup/i);

    // And the recovery half: name the daemon that is actually holding
    // the port, and the home it is rooted in. Without this the user is
    // told only that the daemon THEY just started died, while nothing
    // mentions the one that was already there.
    expect(message).toContain("already listening");
    expect(message).toContain(path.join(dirA, RELATIVE_HOME));
    expect(message).toContain(path.join(dirB, RELATIVE_HOME));

    // The relative value itself is called out, once, by whichever
    // process resolved it.
    expect(message).toMatch(/HYDRA_ACP_HOME is relative/);
  }, 180_000);
});
