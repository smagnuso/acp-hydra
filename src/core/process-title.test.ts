import { describe, it, expect, vi } from "vitest";
import {
  buildTitleFromArgv,
  setHydraProcessTitle,
} from "./process-title.js";

describe("buildTitleFromArgv", () => {
  it("joins argv with the given prefix as the first token", () => {
    expect(buildTitleFromArgv(["cat", "-p", "watch logs"], "hydra")).toBe(
      "hydra cat -p watch logs",
    );
  });

  it("returns just the prefix when argv is empty", () => {
    expect(buildTitleFromArgv([], "hydra")).toBe("hydra");
    expect(buildTitleFromArgv([], "hydra-acp")).toBe("hydra-acp");
  });

  it("preserves args containing spaces verbatim (no extra quoting)", () => {
    // process.argv already deals in unquoted tokens — the caller has
    // no need to re-quote, and adding quotes here would lie about
    // what the user typed.
    expect(buildTitleFromArgv(["cat", "-p", "two words"], "hydra")).toBe(
      "hydra cat -p two words",
    );
  });

  it("uses invokedBinName() as the default prefix", () => {
    // Pin argv[1] so the default-prefix path is deterministic.
    const saved = process.argv[1] ?? "";
    process.argv[1] = "/usr/local/bin/hydra";
    try {
      expect(buildTitleFromArgv(["tui"])).toBe("hydra tui");
    } finally {
      process.argv[1] = saved;
    }
  });
});

describe("setHydraProcessTitle", () => {
  // These assert through an injected setTitle rather than reading
  // process.title back. process.title is one value for the whole
  // process, and vitest's thread pool runs many files in sibling
  // workers that each set their own, so a read-back races them.
  it("sets the title to the full string regardless of platform", () => {
    const setTitle = vi.fn();
    setHydraProcessTitle("hydra cat -p watch logs --detach", {
      platform: "darwin",
      writeComm: vi.fn(),
      setTitle,
    });
    expect(setTitle).toHaveBeenCalledWith("hydra cat -p watch logs --detach");
  });

  it("writes the user-invoked bin name to /proc/self/comm on Linux", () => {
    const writeComm = vi.fn();
    setHydraProcessTitle("hydra cat -p something long", {
      platform: "linux",
      writeComm,
      commName: "hydra",
    });
    expect(writeComm).toHaveBeenCalledWith("hydra");
  });

  it("respects an explicit commName override (e.g. hydra-acp when invoked that way)", () => {
    const writeComm = vi.fn();
    setHydraProcessTitle("hydra-acp tui --session foo", {
      platform: "linux",
      writeComm,
      commName: "hydra-acp",
    });
    expect(writeComm).toHaveBeenCalledWith("hydra-acp");
  });

  it("does not write to /proc/self/comm on non-Linux platforms", () => {
    const writeComm = vi.fn();
    setHydraProcessTitle("hydra cat -p something long", {
      platform: "darwin",
      writeComm,
    });
    expect(writeComm).not.toHaveBeenCalled();
  });

  it("survives /proc/self/comm write failures silently (e.g. sandboxed container)", () => {
    const writeComm = vi.fn(() => {
      throw new Error("EACCES: permission denied");
    });
    const setTitle = vi.fn();
    expect(() =>
      setHydraProcessTitle("hydra cat -p test", {
        platform: "linux",
        writeComm,
        commName: "hydra",
        setTitle,
      }),
    ).not.toThrow();
    // The title is still set even though comm failed.
    expect(setTitle).toHaveBeenCalledWith("hydra cat -p test");
  });
});
