// Shared helpers for persisting JSON state files under ~/.hydra-acp.
//
// writeJsonAtomic writes to a sibling temp file and renames it onto the
// final path. POSIX rename within a filesystem is atomic, so a kill or
// crash mid-write leaves either the old file fully intact or the new file
// fully written — never a zero-byte or half-written blob. Plain
// fs.writeFile truncates the target first; if the process dies between
// truncate and write, the file is left empty and any loader that does
// `JSON.parse(raw)` blows up on `Unexpected end of JSON input`.
//
// readJsonSafe is the loader-side counterpart. A missing file, an empty
// file, or a syntax-corrupted file all return undefined so the caller
// can start from defaults rather than crashing. Genuine IO errors
// (EPERM, EACCES, etc.) still throw — those are operator-level and
// shouldn't be silently swallowed.
//
// Together they remove a class of "daemon hangs on startup because some
// JSON file got truncated by an earlier hard kill" failures.
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export interface WriteJsonAtomicOptions {
  mode?: number;
  pretty?: boolean;
}

export async function writeJsonAtomic(
  filePath: string,
  data: unknown,
  opts: WriteJsonAtomicOptions = {},
): Promise<void> {
  const pretty = opts.pretty ?? true;
  const body = (pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)) + "\n";
  await writeFileAtomic(filePath, body, opts);
}

export interface WriteFileAtomicOptions {
  mode?: number;
}

// Same atomicity guarantee as writeJsonAtomic but for callers that have
// already serialized their payload (or are writing non-JSON text like
// the password hash file).
/**
 * Windows replaces a file by unlinking the destination, which fails while
 * anything else holds a handle to it: antivirus mid-scan, the search
 * indexer, another hydra process reading the same record. The error is
 * transient (EPERM / EACCES / EBUSY) and clears in milliseconds.
 *
 * This matters because the write is the last step of an atomic replace,
 * and most callers here are fire-and-forget (`void mutateRecord(...)`,
 * the snapshot handlers). A rejection at that point is swallowed, so
 * without retrying, the visible symptom is not an error: it is state
 * that silently did not persist. That is what a model selection reverting
 * across a daemon restart looks like from the outside.
 *
 * POSIX rename has no such failure mode, so this is a no-op there and
 * the platform check keeps it that way rather than masking a real EPERM.
 *
 * Injectable for tests, which is the only way to exercise a Windows-only
 * failure from anywhere else.
 */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 10;

export async function renameWithRetry(
  from: string,
  to: string,
  deps: {
    rename?: (a: string, b: string) => Promise<void>;
    platform?: NodeJS.Platform;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const rename = deps.rename ?? fs.rename;
  const platform = deps.platform ?? process.platform;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      const retryable =
        platform === "win32" &&
        TRANSIENT_RENAME_CODES.has(code) &&
        attempt < RENAME_ATTEMPTS - 1;
      if (!retryable) {
        throw err;
      }
      // Linear backoff: 10ms, 20ms, ... 90ms — 450ms total, which is far
      // past a scanner's window without stalling a turn if it is not.
      await sleep(10 * (attempt + 1));
    }
  }
}

export async function writeFileAtomic(
  filePath: string,
  body: string,
  opts: WriteFileAtomicOptions = {},
): Promise<void> {
  // If filePath is a symlink, write through to its target rather than
  // renaming a temp file onto the link (rename replaces the symlink node
  // with a regular file, silently severing a config.json that points into
  // a synced/encrypted dotfiles repo). resolveWriteTarget returns the real
  // path to write — preserving the link — even when the target file itself
  // doesn't exist yet (a freshly-decrypted dotfile).
  const target = await resolveWriteTarget(filePath);
  // path.dirname, not a hand-rolled split on "/": a Windows path has no
  // forward slashes, so splitting on one yields "." and the real parent
  // (a session directory that may not exist yet) never gets created,
  // leaving the write to fail with ENOENT on the temp file.
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randSuffix()}`;
  try {
    const writeOpts: { encoding: BufferEncoding; mode?: number } = {
      encoding: "utf8",
    };
    if (opts.mode !== undefined) {
      writeOpts.mode = opts.mode;
    }
    await fs.writeFile(tmp, body, writeOpts);
    await renameWithRetry(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
  if (opts.mode !== undefined) {
    // Defensive: a previous (pre-atomic) write may have left the final
    // path with looser perms, and on some platforms fs.rename preserves
    // the destination's existing mode rather than the temp file's.
    try {
      fsSync.chmodSync(target, opts.mode);
    } catch {
      void 0;
    }
  }
}

// Resolve the path writeFileAtomic should rename onto. When `filePath` is a
// symlink we must write through to its target, because rename(2) onto a
// symlink replaces the link itself with a regular file. We resolve the
// link's destination (relative links are resolved against the link's dir)
// and realpath its parent directory so an intermediate symlink in the path
// (e.g. ~/netflix/private -> ~/private) is followed too. The target file
// need not exist — only its directory — so a symlink to a not-yet-present
// dotfile is re-materialized in place rather than clobbered.
async function resolveWriteTarget(filePath: string): Promise<string> {
  let lst: fsSync.Stats;
  try {
    lst = await fs.lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return filePath;
    }
    throw err;
  }
  if (!lst.isSymbolicLink()) {
    return filePath;
  }
  const dest = await fs.readlink(filePath);
  const abs = path.isAbsolute(dest)
    ? dest
    : path.resolve(path.dirname(filePath), dest);
  try {
    const realDir = await fs.realpath(path.dirname(abs));
    return path.join(realDir, path.basename(abs));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Target directory is missing too (deeper breakage); fall back to the
      // unresolved absolute path and let the write surface the real error.
      return abs;
    }
    throw err;
  }
}

export async function readJsonSafe<T = unknown>(
  filePath: string,
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
  if (raw.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function randSuffix(): string {
  return randomBytes(4).toString("hex");
}
