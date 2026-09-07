import { describe, expect, it, afterEach, vi } from "vitest";
import { isProcessAlive } from "./daemon-pidfile.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function killThrowing(code: string): void {
  vi.spyOn(process, "kill").mockImplementation(() => {
    const err = new Error(code) as NodeJS.ErrnoException;
    err.code = code;
    throw err;
  });
}

describe("isProcessAlive", () => {
  it("reports a signalable process as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("reports ESRCH as dead", () => {
    killThrowing("ESRCH");
    expect(isProcessAlive(4242)).toBe(false);
  });

  it("reports EPERM as ALIVE, not dead", () => {
    // The whole daemon-discovery path hangs off this. libuv implements
    // uv_kill on Windows via OpenProcess(PROCESS_TERMINATE | ...), so a
    // daemon running at a different elevation answers ACCESS_DENIED for
    // a signal-0 probe. Reading that as "not running" makes every caller
    // spawn a redundant daemon that then cannot bind the port.
    killThrowing("EPERM");
    expect(isProcessAlive(4242)).toBe(true);
  });

  it("reports EACCES as alive", () => {
    killThrowing("EACCES");
    expect(isProcessAlive(4242)).toBe(true);
  });

  it("treats an unrecognised failure as dead", () => {
    killThrowing("EINVAL");
    expect(isProcessAlive(4242)).toBe(false);
  });
});
