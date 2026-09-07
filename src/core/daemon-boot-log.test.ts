import { describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import {
  readDaemonBootFailure,
  recordDaemonBootFailure,
} from "./daemon-boot-log.js";
import { paths } from "./paths.js";

describe("daemon boot log", () => {
  it("round-trips a failure recorded after the wait started", async () => {
    const startedAt = Date.now();
    await recordDaemonBootFailure("listen EADDRINUSE 127.0.0.1:55514");
    const got = await readDaemonBootFailure(startedAt);
    expect(got).toContain("EADDRINUSE");
    expect(got).toContain(`pid=${process.pid}`);
  });

  it("returns undefined when nothing was ever recorded", async () => {
    await fsp.rm(paths.daemonBootLog(), { force: true });
    expect(await readDaemonBootFailure(Date.now())).toBeUndefined();
  });

  it("ignores a failure older than the wait", async () => {
    // Otherwise last week's crash gets quoted into today's timeout,
    // which is worse than saying nothing at all.
    await recordDaemonBootFailure("ancient history");
    const wellAfter = Date.now() + 60_000;
    expect(await readDaemonBootFailure(wellAfter)).toBeUndefined();
  });

  it("keeps the most recent entries when several accumulate", async () => {
    await fsp.rm(paths.daemonBootLog(), { force: true });
    const startedAt = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await recordDaemonBootFailure(`attempt ${i}`);
    }
    const got = await readDaemonBootFailure(startedAt, 2);
    expect(got).toContain("attempt 4");
    expect(got).not.toContain("attempt 0");
  });
});
