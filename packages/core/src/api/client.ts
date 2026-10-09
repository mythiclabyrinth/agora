/* Thin fetch wrapper over the agora-server REST API (server.rs).
   All errors come back as {detail}; auth is a single owner bearer token. */

export class ApiError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

export interface Session {
  baseUrl: string; // e.g. "https://agora.example.com" — no trailing slash
  token: string;
}

/** "host:port" or bare URLs become fully-qualified http(s) origins.
    Schemeless input defaults to https — except LAN/loopback addresses, which
    never have certificates. Getting this wrong breaks the live socket: hosts
    like Railway 301 http→https, which fetch follows but WebSocket cannot. */
export function normalizeBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) {
    const host = url.replace(/[:/].*$/, "");
    const isLan =
      /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
      host === "localhost" ||
      host.endsWith(".local");
    url = `${isLan ? "http" : "https"}://${url}`;
  }
  return url;
}

/** The origin fetch actually ended up at (after redirects), so the stored
    base URL matches the server's canonical scheme/host. */
export function originOf(
  finalUrl: string | undefined,
  fallback: string,
): string {
  const m = finalUrl?.match(/^https?:\/\/[^/]+/i);
  return m ? m[0] : fallback;
}

export function wsUrl(session: Session): string {
  const base = session.baseUrl.replace(/^http/i, "ws");
  return `${base}/ws?token=${encodeURIComponent(session.token)}`;
}

/** Address shown to dial-in agents. Callers must pass an http(s) app/server
 * URL; agent sockets always live at its origin rather than below a UI path. */
export function agentWsUrl(origin: string, token: string): string {
  const root =
    origin.match(/^https?:\/\/[^/]+/i)?.[0] || origin.replace(/\/+$/, "");
  return `${root.replace(/^http/i, "ws")}/agent/ws?token=${encodeURIComponent(token)}`;
}

export function fileUrl(session: Session, fileId: string): string {
  return `${session.baseUrl}/api/files/${encodeURIComponent(fileId)}`;
}

export function authHeaders(session: Session): Record<string, string> {
  return { Authorization: `Bearer ${session.token}` };
}

export async function parseError(res: Response): Promise<ApiError> {
  let detail = await res.text();
  try {
    detail = JSON.parse(detail).detail || detail;
  } catch {
    /* plain-text error body */
  }
  return new ApiError(res.status, detail || res.statusText);
}

export class ApiClient {
  constructor(private session: Session) {}

  get base(): string {
    return this.session.baseUrl;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.session.baseUrl}${path}`, {
      ...init,
      headers: {
        ...authHeaders(this.session),
        ...(init.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...(init.headers || {}),
      },
    });
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  put<T>(path: string, body?: unknown, options?: { keepalive?: boolean }): Promise<T> {
    return this.request<T>(path, {
      method: "PUT",
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive: options?.keepalive,
    });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "PATCH",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "DELETE",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Multipart message post: text + up to 5 files (server-enforced). */
  upload<T>(path: string, form: FormData, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, { method: "POST", body: form, signal });
  }
}
