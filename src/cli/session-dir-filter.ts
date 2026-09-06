// Directory scoping for the session listing (`session list --dir`).
// Kept out of the command module so the TUI picker can reuse it.

import * as path from "node:path";
import { expandHome } from "../core/config.js";

export interface DirFilterable {
  cwd: string;
  // Isolated sessions record the workspace in `cwd`; the tree the user
  // thinks of as "the directory" is sourceCwd.
  workspace?: { sourceCwd: string };
}

// Normalizes `--dir` input the same way the import prompt normalizes a
// cwd: tilde/$HOME expansion, then resolve against the process cwd. No
// realpath — session records hold the path as it was given, so
// canonicalizing here would stop a symlinked source tree from matching
// its own sessions.
export function resolveDirFilter(input: string): string {
  const trimmed = input.trim();
  // No trailing-separator trim: path.resolve already did it. The only
  // resolved paths that still end in a separator are roots — "/", "D:\",
  // "\\\\server\\share\\" — and those must keep it. The trim that used to
  // live here guarded on `length > 1`, which reads as "not the root" but
  // only excludes the POSIX one; a Windows drive root is three characters,
  // so it was trimmed to a bare "D:", naming that drive's current
  // directory rather than its root.
  return path.resolve(expandHome(trimmed.length === 0 ? "." : trimmed));
}

// True when the session lives at `dir` or anywhere beneath it. Matches
// on either recorded path, so an isolated session is found by its source
// tree and by its workspace.
export function sessionMatchesDir(s: DirFilterable, dir: string): boolean {
  const candidates = [s.cwd, s.workspace?.sourceCwd];
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      continue;
    }
    const normalized = path.resolve(candidate);
    if (normalized === dir || normalized.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}
