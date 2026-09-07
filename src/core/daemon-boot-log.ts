// Last-resort record of why a detached daemon failed to start.
//
// spawnDaemonDetached gives the daemon no stdio, so anything
// daemon-entry writes on the way out is discarded and the caller sees
// only "did not become ready within 15000ms" — the same message for a
// port collision, an unwritable log directory, a malformed config, and a
// platform bug. This file is the missing half: the daemon appends its
// fatal error here before exiting, and waitForDaemonReady quotes it back.
//
// Only failures are written, so the file stays small; the size cap below
// is for the pathological case of a daemon relaunching in a tight loop.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { paths } from "./paths.js";

const MAX_BOOT_LOG_BYTES = 64 * 1024;

export async function recordDaemonBootFailure(message: string): Promise<void> {
  const file = paths.daemonBootLog();
  const entry = `[${new Date().toISOString()}] pid=${process.pid} ${message}\n`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const size = await fsp
    .stat(file)
    .then((s) => s.size)
    .catch(() => 0);
  if (size > MAX_BOOT_LOG_BYTES) {
    await fsp.writeFile(file, entry, { encoding: "utf8", mode: 0o600 });
    return;
  }
  await fsp.appendFile(file, entry, { encoding: "utf8", mode: 0o600 });
}

/**
 * The boot log's tail, but only if it was written at or after `since`.
 *
 * The timestamp gate is what keeps a stale failure from a previous week
 * out of today's timeout message, which would be worse than saying
 * nothing.
 */
export async function readDaemonBootFailure(
  since: number,
  maxLines = 20,
): Promise<string | undefined> {
  const file = paths.daemonBootLog();
  try {
    const stat = await fsp.stat(file);
    // Whole-second filesystem timestamps can round a write that happened
    // just after `since` down to just before it.
    if (stat.mtimeMs < since - 1_000) {
      return undefined;
    }
    const text = await fsp.readFile(file, "utf8");
    const lines = text.trimEnd().split("\n");
    const tail = lines.slice(-maxLines).join("\n");
    return tail.length > 0 ? tail : undefined;
  } catch {
    return undefined;
  }
}
