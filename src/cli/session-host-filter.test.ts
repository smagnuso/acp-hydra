import { describe, expect, it } from "vitest";
import { matchesHostFilter } from "./session-host-filter.js";

describe("matchesHostFilter", () => {
  it("'all' matches everything", () => {
    expect(matchesHostFilter({}, "all")).toBe(true);
    expect(matchesHostFilter({ remote: "mrclean" }, "all")).toBe(true);
  });

  it("'local' matches plain local sessions and attached imports, not federated ones", () => {
    expect(matchesHostFilter({}, "local")).toBe(true);
    expect(
      matchesHostFilter(
        { importedFromMachine: "old-box", upstreamSessionId: "u_1" },
        "local",
      ),
    ).toBe(true);
    expect(
      matchesHostFilter({ importedFromMachine: "old-box" }, "local"),
    ).toBe(false);
    expect(matchesHostFilter({ remote: "mrclean" }, "local")).toBe(false);
  });

  it("a remote name matches live federated sessions from that remote", () => {
    expect(matchesHostFilter({ remote: "mrclean" }, "mrclean")).toBe(true);
    expect(matchesHostFilter({ remote: "other" }, "mrclean")).toBe(false);
  });

  it("a remote name excludes sessions dormant on that peer's own side", () => {
    expect(
      matchesHostFilter(
        { remote: "mrclean", importedFromMachine: "old-box" },
        "mrclean",
      ),
    ).toBe(false);
    expect(
      matchesHostFilter(
        {
          remote: "mrclean",
          importedFromMachine: "old-box",
          upstreamSessionId: "u_1",
        },
        "mrclean",
      ),
    ).toBe(true);
  });

  it("a machine name still matches legacy dormant bundle-import mirrors", () => {
    expect(
      matchesHostFilter({ importedFromMachine: "machine-b" }, "machine-b"),
    ).toBe(true);
    expect(
      matchesHostFilter(
        { importedFromMachine: "machine-b", upstreamSessionId: "u_1" },
        "machine-b",
      ),
    ).toBe(false);
  });
});
