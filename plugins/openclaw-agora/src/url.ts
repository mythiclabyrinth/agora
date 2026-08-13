const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Loopback keeps plaintext usable for a desktop Agora on the same machine. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * Derive the agent WebSocket URL from the operator-facing Agora URL. http(s)
 * is upgraded to ws(s) so people can paste the address straight out of their
 * browser, and plaintext is refused off loopback: the pairing token travels in
 * the query string.
 */
export function resolveSocketUrl(baseUrl: string, token: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error("Agora URL is required");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Agora URL must be an http(s) or ws(s) URL");
  }
  const scheme = { "http:": "ws:", "https:": "wss:", "ws:": "ws:", "wss:": "wss:" }[
    parsed.protocol
  ];
  if (!scheme) throw new Error("Agora URL must be an http(s) or ws(s) URL");
  if (scheme === "ws:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("plaintext ws:// is allowed only for loopback Agora servers");
  }
  if (!token) throw new Error("Agora pairing token is required");
  parsed.protocol = scheme;
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path.endsWith("/agent/ws") ? path : `${path}/agent/ws`;
  parsed.searchParams.set("token", token);
  parsed.hash = "";
  return parsed.toString();
}

/**
 * Authenticated file route for attachments too large to arrive inline. Derived
 * from the socket URL so a file fetch can never reach a different host than
 * the one holding the connection.
 */
export function resolveFileUrl(socketUrl: string, fileId: string, agentId: string): string {
  const parsed = new URL(socketUrl);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = `/agent/files/${encodeURIComponent(fileId)}`;
  parsed.search = "";
  parsed.searchParams.set("agent_id", agentId);
  return parsed.toString();
}

/** The socket URL carries the token; keep it out of logs and error text. */
export function redactSocketUrl(socketUrl: string): string {
  try {
    const parsed = new URL(socketUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "<invalid agora url>";
  }
}
