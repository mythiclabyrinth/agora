/* Token/fragment intake: ?token= from the desktop shell, #agora_session= /
   #auth_error= from the Google round-trip, #join= from /join/{token}. The
   token lives in localStorage under agora_token. */

export let AUTH_ERROR = "";
export let JOIN_TOKEN = "";
const AUTH_PATH_KEY = "agora_auth_path";

export function initToken(): void {
  const params = new URLSearchParams(location.search);
  const t = params.get("token");
  if (t) {
    localStorage.setItem("agora_token", t);
    // Drop the token from the visible URL/history.
    history.replaceState(window.history.state, "", location.pathname);
  }
  if (location.hash.length > 1) {
    const frag = new URLSearchParams(location.hash.slice(1));
    const session = frag.get("agora_session");
    if (session) localStorage.setItem("agora_token", session);
    AUTH_ERROR = frag.get("auth_error") || "";
    const join = frag.get("join");
    if (join) sessionStorage.setItem("agora_join", join);
    if (session || AUTH_ERROR || join) {
      const pendingPath = sessionStorage.getItem(AUTH_PATH_KEY);
      history.replaceState(window.history.state, "", pendingPath || location.pathname);
      if (session) sessionStorage.removeItem(AUTH_PATH_KEY);
    }
  }
  JOIN_TOKEN = sessionStorage.getItem("agora_join") || "";
}

/** Preserve a conversation path across the full-page Google OAuth trip. */
export function rememberAuthPath(): void {
  if (location.pathname.startsWith("/g/") || location.pathname === "/threads" ||
      location.pathname === "/inbox" || location.pathname.startsWith("/inbox/")) {
    sessionStorage.setItem(AUTH_PATH_KEY, location.pathname);
  }
}

export function sessionToken(): string {
  return localStorage.getItem("agora_token") || "";
}

export function setSessionToken(token: string): void {
  localStorage.setItem("agora_token", token);
}

export function clearJoinToken(): void {
  sessionStorage.removeItem("agora_join");
  JOIN_TOKEN = "";
}

export const AUTH_ERROR_TEXT: Record<string, string> = {
  no_access: "That account isn't a member here — ask an admin to invite your email.",
  disabled: "Your account has been disabled on this instance.",
  google_access_denied: "Google sign-in was cancelled.",
  state: "Sign-in expired — try again.",
  invite_invalid: "That invite link has been used or has expired — ask for a new one.",
};
