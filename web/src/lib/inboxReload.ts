/* A reload of an Inbox tab the app itself navigated to resets to Unreads; a
   pasted or bookmarked /inbox/threads keeps Threads. writeHistory always
   writes a non-null {} state, and history.state survives a reload of the
   same entry, so a null state means the URL came from outside the app. */
export function inboxPathAfterReload(pathname: string, navigationType: string | undefined, state: unknown): string | null {
  return pathname === "/inbox/threads" && navigationType === "reload" && state !== null ? "/inbox/unreads" : null;
}

export function resetInboxTabOnReload(): void {
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const next = inboxPathAfterReload(location.pathname, nav?.type, history.state);
  if (next) history.replaceState(null, "", next);
}
