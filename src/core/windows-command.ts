// Windows command resolution for spawn().
//
// Node's spawn() does not apply PATHEXT. `spawn("npm", [...])` looks for
// a file literally named `npm`, which does not exist on Windows: npm
// ships as `npm.cmd`. The same trap sits under npm's
// `node_modules/.bin/` shims, where the extensionless file is a POSIX sh
// script that CreateProcess cannot run and the executable sibling is
// `<name>.cmd`.
//
// Two follow-on constraints, both Windows-only:
//
//   1. A `.cmd` / `.bat` file is not a PE image, so CreateProcess cannot
//      launch it. It has to go through cmd.exe, which is what Node's
//      `shell: true` does.
//   2. With `shell: true` Node sets windowsVerbatimArguments and joins
//      the command line itself, so quoting each token is the caller's
//      job. quoteForCmd does that, and refuses tokens it cannot quote
//      safely rather than emitting something cmd.exe would re-interpret.
//
// Everything here is identity on non-Windows.

import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface SpawnTarget {
  command: string;
  args: string[];
  // True when the resolved command is a cmd/bat shim. Callers must pass
  // `shell: true` to spawn(); command and args are already quoted for it.
  shell: boolean;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// PATHEXT is conventionally uppercase (".COM;.EXE;.BAT;.CMD") while the
// files it matches are usually lowercase (`npm.cmd`). Windows does not
// care, but probing by stat() does the moment the filesystem is
// case-sensitive, which is true of a case-sensitive NTFS directory, a
// mounted share, and every machine this is unit-tested on. Try both.
function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  const declared = (env["PATHEXT"] ?? DEFAULT_PATHEXT)
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  const out: string[] = [];
  for (const ext of declared) {
    for (const variant of [ext, ext.toLowerCase(), ext.toUpperCase()]) {
      if (!out.includes(variant)) {
        out.push(variant);
      }
    }
  }
  return out;
}

function hasKnownExtension(command: string, exts: readonly string[]): boolean {
  const lower = command.toLowerCase();
  return exts.some((ext) => lower.endsWith(ext.toLowerCase()));
}

/**
 * Resolve `command` to something CreateProcess can actually launch.
 *
 * Returns the input unchanged on non-Windows, and whenever nothing
 * better is found, so a genuinely missing command still reaches spawn()
 * and produces the same ENOENT it does today.
 *
 * An extensionless path that exists on disk is deliberately NOT accepted
 * as-is: that is exactly the npm sh-shim case, where the sibling
 * `<name>.cmd` is the one that runs.
 */
export function resolveWindowsCommand(
  command: string,
  deps: ResolveDeps = {},
): string {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    return command;
  }
  const env = deps.env ?? process.env;
  const exts = pathExtensions(env);
  if (hasKnownExtension(command, exts)) {
    return command;
  }
  // A path (absolute or explicitly relative) is not searched on PATH;
  // only its extension-bearing siblings are considered.
  if (/[\\/]/.test(command)) {
    for (const ext of exts) {
      const candidate = command + ext;
      if (isFile(candidate)) {
        return candidate;
      }
    }
    return command;
  }
  const pathVar = env["PATH"] ?? env["Path"] ?? "";
  for (const dir of pathVar.split(delimiter).filter((d) => d.length > 0)) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return command;
}

// Characters cmd.exe re-interprets even inside double quotes, or that
// cannot be escaped without ambiguity. None of them appear in the paths,
// package specs and registry URLs hydra passes through here, so refusing
// is better than emitting a command line that means something else.
const CMD_UNQUOTABLE = /["%\r\n]/;

export function quoteForCmd(token: string): string {
  if (CMD_UNQUOTABLE.test(token)) {
    throw new Error(
      `cannot pass ${JSON.stringify(token)} through cmd.exe: it contains ` +
        `a quote, a percent sign, or a newline, none of which can be ` +
        `escaped unambiguously`,
    );
  }
  return /[\s&|<>^()]/.test(token) ? `"${token}"` : token;
}

/**
 * Resolve a command plus its args into something spawn() can take.
 *
 * When `shell` comes back true the caller must pass `shell: true`
 * through to spawn(); the returned command and args are already quoted
 * and must not be quoted again.
 */
export function resolveSpawnTarget(
  command: string,
  args: readonly string[],
  deps: ResolveDeps = {},
): SpawnTarget {
  const platform = deps.platform ?? process.platform;
  const resolved = resolveWindowsCommand(command, deps);
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(resolved)) {
    return { command: resolved, args: [...args], shell: false };
  }
  return {
    command: quoteForCmd(resolved),
    args: args.map(quoteForCmd),
    shell: true,
  };
}
