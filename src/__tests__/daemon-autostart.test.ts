// End-to-end cover for autostarting a detached daemon.
//
// `hydra daemon start` without --foreground is spawnDaemonDetached
// followed by waitForDaemonReady, which is the exact sequence issue #9
// reports failing: "daemon not running; starting it..." and then a
// readiness timeout. Nothing tested it, because it cannot be tested
// in-process — spawnDaemonDetached resolves ./daemon.js relative to its
// own module, so it only resolves inside dist/.
//
// That makes this the one test that exercises the real seam: a detached
// child, its own stdio, the pidfile it writes, and the parent's ability
// to find it afterwards. On Windows it additionally covers detached +
// windowsHide + process.execPath, which is as close to reproducing the
// reporter's environment as is possible without Zed.
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../core/paths.js";
import { readDaemonPidFile, isProcessAlive } from "../core/daemon-pidfile.js";
import { writeServiceToken } from "../core/service-token.js";
import { pickFreePort } from "./test-utils.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const CLI_BUNDLE = path.join(REPO_ROOT, "dist", "cli.js");

// `npm test` is routinely run without a build, and this needs one. CI
// builds first (see .github/workflows/ci.yml) so it always runs there.
const built = existsSync(CLI_BUNDLE);
const describeBuilt = built ? describe : describe.skip;


let daemonPid: number | undefined;

afterEach(async () => {
  // The daemon is detached by design, so it outlives the test unless it
  // is killed explicitly. Read the pid back rather than tracking the
  // child we spawned: that child is only the transient parent.
  const info = await readDaemonPidFile().catch(() => undefined);
  const pid = info?.pid ?? daemonPid;
  daemonPid = undefined;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
  for (let i = 0; i < 50 && isProcessAlive(pid); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
});

async function runCli(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BUNDLE, ...args], {
      env: { ...process.env, HYDRA_ACP_HOME: paths.home() },
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
      reject(
        new Error(
          `hydra ${args.join(" ")} did not exit within ${timeoutMs}ms\n` +
            `stdout: ${stdout}\nstderr: ${stderr}`,
        ),
      );
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

describeBuilt("daemon autostart (detached)", () => {
  it("starts a detached daemon and finds it again", async () => {
    const port = await pickFreePort();
    await fsp.mkdir(paths.home(), { recursive: true });
    await fsp.writeFile(
      paths.config(),
      JSON.stringify({ daemon: { port, logLevel: "error" } }),
      "utf8",
    );
    await writeServiceToken("hydra_token_0123456789abcdef0123456789abcdef");

    const result = await runCli(["daemon", "start"], 60_000);

    // The failure this guards against reports success on stderr and then
    // times out, so assert on the outcome rather than the exit code
    // alone; include both streams so a red CI run is diagnosable.
    expect(
      result.code,
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(0);
    expect(result.stdout).toContain("Daemon started");

    const info = await readDaemonPidFile();
    expect(info, "daemon start returned 0 but wrote no pidfile").toBeDefined();
    daemonPid = info!.pid;
    expect(isProcessAlive(info!.pid)).toBe(true);
    expect(info!.loopbackPort).toBe(port);

    const health = await fetch(
      `http://127.0.0.1:${info!.loopbackPort}/v1/health`,
    );
    expect(health.ok).toBe(true);
  }, 90_000);

  it("reports the daemon as running once it is up", async () => {
    const port = await pickFreePort();
    await fsp.mkdir(paths.home(), { recursive: true });
    await fsp.writeFile(
      paths.config(),
      JSON.stringify({ daemon: { port, logLevel: "error" } }),
      "utf8",
    );
    await writeServiceToken("hydra_token_0123456789abcdef0123456789abcdef");

    await runCli(["daemon", "start"], 60_000);
    const status = await runCli(["daemon", "status"], 30_000);
    expect(status.stdout).toContain("running");
  }, 90_000);
});
