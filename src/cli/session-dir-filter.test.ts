import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import * as path from "node:path";
import { resolveDirFilter, sessionMatchesDir } from "./session-dir-filter.js";

// These exercise absolute-path handling, and "absolute" is spelled
// differently per platform: resolveDirFilter runs path.resolve, so a
// POSIX literal like abs("home", "u", "dev") comes back as "C:\home\u\dev" on
// Windows. Build the fixtures the same way the code normalizes them.
const abs = (...segments: string[]): string =>
  path.resolve(path.sep, ...segments);
const home = (...segments: string[]): string =>
  path.join(homedir(), ...segments);

describe("resolveDirFilter", () => {
  it("expands ~ and $HOME", () => {
    expect(resolveDirFilter("~/dev/foo")).toBe(home("dev", "foo"));
    expect(resolveDirFilter("$HOME/dev/foo")).toBe(home("dev", "foo"));
  });

  it("resolves relative paths against the process cwd", () => {
    expect(resolveDirFilter(".")).toBe(process.cwd());
  });

  it("strips a trailing separator but keeps root", () => {
    expect(resolveDirFilter("/tmp/foo/")).toBe(abs("tmp", "foo"));
    // Root keeps its separator: path.resolve(path.sep) is "/" on POSIX
    // and "D:\\" on Windows, and neither should be trimmed to nothing.
    expect(resolveDirFilter(path.sep)).toBe(path.resolve(path.sep));
  });

  it("treats empty input as the current directory", () => {
    expect(resolveDirFilter("   ")).toBe(process.cwd());
  });
});

describe("sessionMatchesDir", () => {
  it("matches the directory itself and its subtree", () => {
    expect(sessionMatchesDir({ cwd: abs("home", "u", "dev", "foo") }, abs("home", "u", "dev", "foo"))).toBe(true);
    expect(sessionMatchesDir({ cwd: abs("home", "u", "dev", "foo", "pkg", "a") }, abs("home", "u", "dev", "foo"))).toBe(true);
    expect(sessionMatchesDir({ cwd: abs("home", "u", "dev") }, abs("home", "u", "dev", "foo"))).toBe(false);
  });

  it("respects path boundaries", () => {
    expect(sessionMatchesDir({ cwd: abs("home", "u", "dev", "foobar") }, abs("home", "u", "dev", "foo"))).toBe(false);
  });

  it("matches an isolated session by its source tree", () => {
    const s = {
      cwd: abs("home", "u", ".hydra-acp", "workspaces", "ws-1"),
      workspace: { sourceCwd: abs("home", "u", "dev", "foo") },
    };
    expect(sessionMatchesDir(s, abs("home", "u", "dev", "foo"))).toBe(true);
    expect(sessionMatchesDir(s, abs("home", "u", ".hydra-acp", "workspaces"))).toBe(true);
    expect(sessionMatchesDir(s, abs("home", "u", "dev", "bar"))).toBe(false);
  });

  it("ignores a missing or empty cwd", () => {
    expect(sessionMatchesDir({ cwd: "" }, abs("home", "u", "dev", "foo"))).toBe(false);
  });

  it("normalizes a recorded path with a trailing separator", () => {
    const trailing = abs("home", "u", "dev", "foo") + path.sep;
    expect(sessionMatchesDir({ cwd: trailing }, abs("home", "u", "dev", "foo"))).toBe(true);
  });
});
