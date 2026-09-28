/* Small formatting helpers shared by the clients. */

export function fmtTs(ts: number | null | undefined): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Compact, local-time label for a thread's latest reply. */
export function fmtLastReply(ts: number, now = Date.now()): string {
  const reply = new Date(ts * 1000);
  const today = new Date(now);
  const sameDay = reply.getFullYear() === today.getFullYear()
    && reply.getMonth() === today.getMonth()
    && reply.getDate() === today.getDate();
  if (sameDay) return reply.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (reply.getFullYear() === today.getFullYear()) {
    return reply.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  return reply.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

/** Full local date and time for tooltips and accessibility labels. */
export function fmtLastReplyFull(ts: number): string {
  return new Date(ts * 1000).toLocaleString([], {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function slugify(name: string): string {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "Talk to" addressing as a routable mention prefix ("@a, @b"), "" when none. */
export function mentionPrefix(agents: { name: string }[]): string {
  return agents.map((a) => "@" + slugify(a.name)).join(", ");
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
