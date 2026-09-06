// Shared policy for the pino-roll rotated log files the daemon and every
// supervised child write.
//
// pino-roll writes `<base>.<N>` files and maintains a `current.log`
// symlink pointing at the active one. The symlink is the user-facing
// path: `hydra logs` and `hydra extension log <name>` tail it, and it
// follows a rotation transparently.
//
// Creating a symlink on Windows needs Developer Mode or administrator
// rights, and pino-roll creates it synchronously inside createPinoRoll,
// so asking for one on a machine without those rights throws EPERM and
// takes the entire logger down with it. For the daemon that means it
// never starts; for an extension it means the supervisor's catch
// reschedules a spawn that will fail identically, forever.
//
// So: no symlink on Windows, and the readers fall back to picking the
// newest rotated file themselves.

import * as fsp from "node:fs/promises";
import * as path from "node:path";

export const ROLLING_LOG_SYMLINK_SUPPORTED = process.platform !== "win32";

const CURRENT_LOG_BASENAME = "current.log";

/**
 * Resolve a tailable path for a rolling log.
 *
 * Returns `logPath` untouched when it exists, which is the normal case
 * everywhere the `current.log` symlink could be created. Otherwise, when
 * the caller asked for a `current.log` that is absent, falls back to the
 * highest-numbered `<base>.<N>` sibling in the same directory.
 *
 * Returns `logPath` unchanged when there is no such sibling either, so
 * the caller still reports its own "no log file" message against the
 * path the user would recognize.
 */
export async function resolveRollingLogPath(logPath: string): Promise<string> {
  try {
    await fsp.stat(logPath);
    return logPath;
  } catch {
    void 0;
  }
  if (path.basename(logPath) !== CURRENT_LOG_BASENAME) {
    return logPath;
  }
  const dir = path.dirname(logPath);
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return logPath;
  }
  let best: { name: string; n: number } | undefined;
  for (const name of entries) {
    // pino-roll's numbering is a trailing `.<N>` on the configured base
    // file, e.g. `daemon.log.3` or `slack.log.12`.
    const m = /\.(\d+)$/.exec(name);
    if (!m) {
      continue;
    }
    const n = Number(m[1]);
    if (!Number.isFinite(n)) {
      continue;
    }
    if (!best || n > best.n) {
      best = { name, n };
    }
  }
  return best ? path.join(dir, best.name) : logPath;
}
