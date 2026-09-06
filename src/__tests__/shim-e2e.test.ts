// End-to-end cover for `hydra-acp shim`, the editor-facing entry point.
//
// runShim had no test at all. The existing shim tests drive wireShim
// over in-memory streams, which is the message plumbing AFTER a
// connection exists; everything before that — resolve a target, probe
// for a daemon, autostart one, wait for it, dial the WS — was never
// executed by a test on any platform. That prologue is what issue #9
// fails in, and it is only reachable by running the real binary, since
// runShim reads process.stdin/stdout directly and spawnDaemonDetached
// resolves ./daemon.js relative to its own module.
//
// So these spawn dist/cli.js and speak NDJSON JSON-RPC to it exactly as
// an editor would.
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ACP_PROTOCOL_VERSION } from "../acp/types-jsonrpc.js";
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
const describeBuilt = existsSync(CLI_BUNDLE) ? describe : describe.skip;

const TOKEN = "hydra_token_0123456789abcdef0123456789abcdef";


async function seedHome(): Promise<number> {
  const port = await pickFreePort();
  await fsp.mkdir(paths.home(), { recursive: true });
  await fsp.writeFile(
    paths.config(),
    JSON.stringify({ daemon: { port, logLevel: "error" } }),
    "utf8",
  );
  await writeServiceToken(TOKEN);
  return port;
}

interface Shim {
  child: ChildProcess;
  request: (method: string, params: unknown, id: number) => Promise<unknown>;
  stderr: () => string;
}

function startShim(): Shim {
  const child = spawn(process.execPath, [CLI_BUNDLE, "shim"], {
    env: { ...process.env, HYDRA_ACP_HOME: paths.home() },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderrText = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (c: string) => (stderrText += c));

  // NDJSON in, NDJSON out. Responses are matched by id rather than by
  // arrival order, because the daemon is free to interleave
  // notifications with the reply.
  let buffer = "";
  const pending = new Map<number, (v: unknown) => void>();
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (line.length === 0) {
        continue;
      }
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        // Not JSON; the shim should not emit any, but never let a stray
        // line reject a request that would otherwise succeed.
      }
    }
  });

  return {
    child,
    stderr: () => stderrText,
    request: (method, params, id) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              `no response to ${method} within 45s\nstderr: ${stderrText}`,
            ),
          );
        }, 45_000);
        pending.set(id, (v) => {
          clearTimeout(timer);
          resolve(v);
        });
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
  };
}

function initializeParams(): unknown {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "hydra-acp-e2e", version: "0.0.0" },
  };
}

let shim: Shim | undefined;

afterEach(async () => {
  if (shim) {
    shim.child.kill();
    shim = undefined;
  }
  const info = await readDaemonPidFile().catch(() => undefined);
  if (info) {
    try {
      process.kill(info.pid);
    } catch {
      // already gone
    }
    for (let i = 0; i < 50 && isProcessAlive(info.pid); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

describeBuilt("hydra-acp shim (end to end)", () => {
  it("autostarts a daemon and answers initialize", async () => {
    // The issue #9 shape: an editor launches the shim with no daemon
    // running. It must start one, wait for it, and then behave like a
    // normal ACP agent on stdio.
    await seedHome();
    shim = startShim();

    const reply = (await shim.request("initialize", initializeParams(), 1)) as {
      id: number;
      result?: { protocolVersion?: number };
      error?: unknown;
    };

    expect(reply.error, `shim stderr: ${shim.stderr()}`).toBeUndefined();
    expect(reply.id).toBe(1);
    expect(reply.result).toBeDefined();

    const info = await readDaemonPidFile();
    expect(info, "shim answered but no daemon pidfile was written").toBeDefined();
    expect(isProcessAlive(info!.pid)).toBe(true);

    // Assert the autostart branch is the one that ran. Without this the
    // test would still pass if a daemon were somehow already up, which
    // would make it silently stop covering the thing it exists for.
    expect(shim.stderr()).toContain("daemon not running");
  }, 120_000);

  it("attaches to an already-running daemon without starting another", async () => {
    // The half that actually distinguishes #9: with a healthy daemon
    // already up, the shim must FIND it. Reporting "daemon not running"
    // here is the bug, so assert on that line rather than only on the
    // reply, since autostarting a second daemon can still end up working
    // and would hide the regression.
    await seedHome();
    const start = spawn(process.execPath, [CLI_BUNDLE, "daemon", "start"], {
      env: { ...process.env, HYDRA_ACP_HOME: paths.home() },
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      start.on("exit", () => resolve());
      start.on("error", reject);
    });
    const before = await readDaemonPidFile();
    expect(before, "daemon start wrote no pidfile").toBeDefined();

    shim = startShim();
    const reply = (await shim.request("initialize", initializeParams(), 1)) as {
      error?: unknown;
    };
    expect(reply.error, `shim stderr: ${shim.stderr()}`).toBeUndefined();

    expect(shim.stderr()).not.toContain("daemon not running");
    const after = await readDaemonPidFile();
    expect(after!.pid).toBe(before!.pid);
  }, 120_000);
});
