// Shared "--host" filter test for `session list` and `session changes`.
// Mirrors picker.ts's filterByHost (see its doc comment for the full
// bucket semantics) but keeps the CLI's flat, unprefixed flag surface:
// "local" (default), "all", or a name that may resolve to either a live
// `hydra remote` (session.remote) or the older bundle-import breadcrumb
// (session.importedFromMachine). If a remote happens to be registered
// under the same name as an old import's origin machine, both match —
// the TUI picker avoids that by namespacing ("remote:"/"host:"), which
// the CLI flag doesn't do.
export function matchesHostFilter(
  s: {
    importedFromMachine?: string;
    upstreamSessionId?: string;
    remote?: string;
  },
  host: string,
): boolean {
  if (host === "all") {
    return true;
  }
  if (host === "local") {
    return !s.remote && (!s.importedFromMachine || !!s.upstreamSessionId);
  }
  // A federated session that is itself a dormant, never-attached import
  // mirror on the peer's own side isn't "happening on that remote" in
  // any useful sense — same reasoning as isDormantOnPeer in picker.ts.
  const dormantOnPeer = !!s.importedFromMachine && !s.upstreamSessionId;
  return (
    (s.remote === host && !dormantOnPeer) ||
    (s.importedFromMachine === host && !s.upstreamSessionId)
  );
}
