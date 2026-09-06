import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  quoteForCmd,
  resolveSpawnTarget,
  resolveWindowsCommand,
} from "./windows-command.js";

// The whole point of this module is behavior on a platform the suite does
// not run on, so `platform` is injected and the fixture files are real.
// statSync does not care which OS named them.
let dir: string;
let binDir: string;
let spacedDir: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hydra-wincmd-"));
  binDir = join(dir, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  // Exactly what npm lays down on Windows: a POSIX sh shim with no
  // extension, plus the .cmd that is the one CreateProcess can run.
  writeFileSync(join(binDir, "claude-code-acp"), "#!/bin/sh\n");
  writeFileSync(join(binDir, "claude-code-acp.cmd"), "@echo off\n");
  writeFileSync(join(dir, "npm.cmd"), "@echo off\n");
  writeFileSync(join(dir, "real-tool.exe"), "MZ");
  spacedDir = join(dir, "First Last");
  mkdirSync(spacedDir, { recursive: true });
  writeFileSync(join(spacedDir, "npm.cmd"), "@echo off\n");
  env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveWindowsCommand", () => {
  it("is identity off Windows even when a .cmd sibling exists", () => {
    expect(
      resolveWindowsCommand("npm", { env, platform: "linux" }),
    ).toBe("npm");
  });

  it("finds a bare command on PATH via PATHEXT", () => {
    expect(resolveWindowsCommand("npm", { env, platform: "win32" })).toBe(
      join(dir, "npm.cmd"),
    );
  });

  it("prefers the .cmd sibling over an extensionless npm sh shim", () => {
    // The regression this module exists for: the extensionless file DOES
    // exist, so any "does it exist" check picks the unrunnable one.
    const shim = join(binDir, "claude-code-acp");
    expect(resolveWindowsCommand(shim, { env, platform: "win32" })).toBe(
      `${shim}.cmd`,
    );
  });

  it("leaves a command that already carries an extension alone", () => {
    const exe = join(dir, "real-tool.exe");
    expect(resolveWindowsCommand(exe, { env, platform: "win32" })).toBe(exe);
  });

  it("returns the input unchanged when nothing resolves", () => {
    expect(
      resolveWindowsCommand("definitely-not-here", { env, platform: "win32" }),
    ).toBe("definitely-not-here");
  });

  it("searches every PATH entry", () => {
    const multi = { ...env, PATH: [join(dir, "nope"), dir].join(delimiter) };
    expect(
      resolveWindowsCommand("npm", { env: multi, platform: "win32" }),
    ).toBe(join(dir, "npm.cmd"));
  });
});

describe("quoteForCmd", () => {
  it("leaves an ordinary token bare", () => {
    expect(quoteForCmd("install")).toBe("install");
    expect(quoteForCmd("@scope/pkg@1.2.3")).toBe("@scope/pkg@1.2.3");
  });

  it("quotes a path containing spaces", () => {
    expect(quoteForCmd(String.raw`C:\Users\First Last\x`)).toBe(
      String.raw`"C:\Users\First Last\x"`,
    );
  });

  it("quotes cmd metacharacters", () => {
    expect(quoteForCmd("a&b")).toBe('"a&b"');
  });

  it("refuses tokens it cannot quote unambiguously", () => {
    // Rather than emit a command line cmd.exe would re-interpret.
    expect(() => quoteForCmd('say "hi"')).toThrow(/cannot pass/i);
    expect(() => quoteForCmd("%PATH%")).toThrow(/cannot pass/i);
    expect(() => quoteForCmd("a\nb")).toThrow(/cannot pass/i);
  });
});

describe("resolveSpawnTarget", () => {
  it("does not ask for a shell off Windows", () => {
    const t = resolveSpawnTarget("npm", ["install"], {
      env,
      platform: "linux",
    });
    expect(t).toEqual({ command: "npm", args: ["install"], shell: false });
  });

  it("asks for a shell and pre-quotes args when it resolves to a .cmd", () => {
    const t = resolveSpawnTarget("npm", ["install", "a b"], {
      env,
      platform: "win32",
    });
    expect(t.shell).toBe(true);
    expect(t.command).toBe(join(dir, "npm.cmd"));
    expect(t.args).toEqual(["install", '"a b"']);
  });

  it("quotes an install path containing spaces", () => {
    // The `C:\Users\First Last\...` case: with shell:true Node sets
    // windowsVerbatimArguments and joins the command line itself, so an
    // unquoted space here would split the command.
    const spacedEnv = { ...env, PATH: spacedDir };
    const t = resolveSpawnTarget("npm", [], {
      env: spacedEnv,
      platform: "win32",
    });
    expect(t.shell).toBe(true);
    expect(t.command).toBe(`"${join(spacedDir, "npm.cmd")}"`);
  });

  it("does not ask for a shell for a real executable", () => {
    const t = resolveSpawnTarget("real-tool", [], { env, platform: "win32" });
    expect(t.shell).toBe(false);
    expect(t.command).toBe(join(dir, "real-tool.exe"));
  });

  it("leaves an unresolvable command to spawn's own ENOENT", () => {
    const t = resolveSpawnTarget("nope", ["-x"], { env, platform: "win32" });
    expect(t).toEqual({ command: "nope", args: ["-x"], shell: false });
  });
});
