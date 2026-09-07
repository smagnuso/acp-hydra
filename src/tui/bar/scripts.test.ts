import { describe, expect, it, vi } from "vitest";
import { collectScriptCommands, createScriptRunner, type ScriptRunner } from "./scripts.js";
import type { ExecFn } from "../shared/process-runner.js";
import type { BarLayoutConfig } from "./types.js";

function emptyBarConfig(): BarLayoutConfig {
  return {
    composer: {
      top: { left: [], right: [] },
      bottom: { left: [], right: [] },
    },
    sessionbar: { left: [], right: [] },
  };
}

describe("collectScriptCommands", () => {
  it("collects a script entry at its default refresh", () => {
    const cfg = emptyBarConfig();
    cfg.composer.top.left = [{ script: "date" }];
    expect(collectScriptCommands(cfg, 5_000)).toEqual(new Map([["date", 5_000]]));
  });

  it("ignores entries without a script (field, text)", () => {
    const cfg = emptyBarConfig();
    cfg.composer.top.left = ["status", { text: "hi" }];
    expect(collectScriptCommands(cfg, 5_000).size).toBe(0);
  });

  it("honors a per-entry refreshMs override", () => {
    const cfg = emptyBarConfig();
    cfg.composer.top.left = [{ script: "date", refreshMs: 2_000 }];
    expect(collectScriptCommands(cfg, 5_000)).toEqual(new Map([["date", 2_000]]));
  });

  it("dedups the same command across regions, keeping the minimum refreshMs", () => {
    const cfg = emptyBarConfig();
    cfg.composer.top.left = [{ script: "date", refreshMs: 5_000 }];
    cfg.sessionbar.right = [{ script: "date", refreshMs: 1_000 }];
    expect(collectScriptCommands(cfg, 5_000)).toEqual(new Map([["date", 1_000]]));
  });

  it("walks all six sides", () => {
    const cfg: BarLayoutConfig = {
      composer: {
        top: { left: [{ script: "a" }], right: [{ script: "b" }] },
        bottom: { left: [{ script: "c" }], right: [{ script: "d" }] },
      },
      sessionbar: { left: [{ script: "e" }], right: [{ script: "f" }] },
    };
    expect([...collectScriptCommands(cfg, 5_000).keys()].sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });
});

describe("createScriptRunner", () => {
  // A stand-in for child_process.exec that completes only when the test
  // says so. Nothing here needs a real shell: the policy under test is
  // "when do we spawn", and the transformation under test is "what do we
  // do with the stdout we get back". Spawning to find out made every one
  // of these wait on process creation, which on a loaded Windows runner is
  // slow enough to lose the race — that is what turned master red on the
  // merge of #10, and no timeout would have fixed it, only made it rarer.
  const fakeExec = (): {
    exec: ExecFn;
    calls: string[];
    settle: (err: Error | null, stdout: string) => void;
  } => {
    const calls: string[] = [];
    let pending: Array<(err: Error | null, stdout: string) => void> = [];
    return {
      calls,
      exec: (command, _options, callback) => {
        calls.push(command);
        pending.push(callback);
      },
      settle: (err, stdout) => {
        const due = pending;
        pending = [];
        for (const cb of due) {
          cb(err, stdout);
        }
      },
    };
  };

  const runnerWith = (
    fake: ReturnType<typeof fakeExec>,
    outputs: Map<string, string | null>,
    onEach?: () => void,
  ): ScriptRunner =>
    createScriptRunner({
      cwd: () => null,
      exec: fake.exec,
      onOutput: (command, output) => {
        onEach?.();
        outputs.set(command, output);
      },
    });

  it("collapses whitespace in stdout to a single line", () => {
    const fake = fakeExec();
    const outputs = new Map<string, string | null>();
    runnerWith(fake, outputs).poll(new Map([["cmd", 1_000]]), 0);
    fake.settle(null, "  hi  there  ");
    expect(outputs.get("cmd")).toBe("hi there");
  });

  it("collapses multi-line stdout to a single space-joined line", () => {
    const fake = fakeExec();
    const outputs = new Map<string, string | null>();
    runnerWith(fake, outputs).poll(new Map([["cmd", 1_000]]), 0);
    fake.settle(null, "line1\nline2\n");
    expect(outputs.get("cmd")).toBe("line1 line2");
  });

  it("reports null on a non-zero exit", () => {
    const fake = fakeExec();
    const outputs = new Map<string, string | null>();
    runnerWith(fake, outputs).poll(new Map([["cmd", 1_000]]), 0);
    fake.settle(new Error("exit 1"), "ignored");
    expect(outputs.get("cmd")).toBeNull();
  });

  it("reports null when stdout is empty", () => {
    const fake = fakeExec();
    const outputs = new Map<string, string | null>();
    runnerWith(fake, outputs).poll(new Map([["cmd", 1_000]]), 0);
    fake.settle(null, "   \n  ");
    expect(outputs.get("cmd")).toBeNull();
  });

  it("does not re-spawn a command already in flight", () => {
    const fake = fakeExec();
    const outputs = new Map<string, string | null>();
    const runner = runnerWith(fake, outputs);
    // Two polls, both due by refreshMs, with nothing settled in between:
    // the first command is still running when the second poll arrives.
    runner.poll(new Map([["slow", 0]]), 0);
    runner.poll(new Map([["slow", 0]]), 10);
    expect(fake.calls.length).toBe(1);
    fake.settle(null, "done");
    expect(outputs.get("slow")).toBe("done");
  });

  it("does not re-spawn a command before its refreshMs elapses", () => {
    const fake = fakeExec();
    const outputs = new Map<string, string | null>();
    const runner = runnerWith(fake, outputs);
    runner.poll(new Map([["again", 10_000]]), 0);
    fake.settle(null, "out");
    expect(outputs.has("again")).toBe(true);
    // Still well within the 10s window: a second poll must not re-run it.
    runner.poll(new Map([["again", 10_000]]), 100);
    expect(fake.calls.length).toBe(1);
  });

  it("runs a real command through the default exec", async () => {
    // The one test that spawns anything. Everything above injects, so this
    // is the only place the default wiring is exercised: without it, exec
    // could be misconfigured and every other test here would still pass.
    const outputs = new Map<string, string | null>();
    const runner = createScriptRunner({
      cwd: () => null,
      onOutput: (command, output) => outputs.set(command, output),
    });
    // cmd.exe does not strip single quotes, so they would land in the
    // output verbatim; the assertion is about the wiring, not quoting.
    const command =
      process.platform === "win32" ? "echo   hi  there  " : "echo '  hi  there  '";
    runner.poll(new Map([[command, 1_000]]), 0);
    await vi.waitFor(
      () => {
        expect(outputs.get(command)).toBe("hi there");
      },
      { timeout: 15_000, interval: 50 },
    );
  });
});
