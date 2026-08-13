/* Sign-in card. Google leads when offered; operators may hide the admin-key
   form from interactive clients without invalidating the key itself. */

import { useEffect, useRef, useState } from "react";
import { WEBSITE_URL } from "@agora/core";
import {
  AUTH_ERROR, AUTH_ERROR_TEXT, JOIN_TOKEN, rememberAuthPath, setSessionToken,
} from "../lib/auth";
import { toast } from "../lib/toast";

export function AuthGate({ onSignedIn }: { onSignedIn: () => void }) {
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [adminEnabled, setAdminEnabled] = useState(true);
  const [probed, setProbed] = useState(false);
  const [showTokenForm, setShowTokenForm] = useState(true);
  const [error] = useState(() =>
    AUTH_ERROR ? (AUTH_ERROR_TEXT[AUTH_ERROR] || "Google sign-in failed — try again.") : "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    fetch("/api/auth/config", { signal: controller.signal }).then(r => r.json()).then(cfg => {
      const admin = cfg.admin?.enabled !== false;
      setAdminEnabled(admin);
      if (cfg.google && cfg.google.enabled) {
        setGoogleEnabled(true);
        setShowTokenForm(false);
      } else if (!admin) {
        setShowTokenForm(false);
      }
      setProbed(true);
    }).catch(() => setProbed(true)).finally(() => window.clearTimeout(timeout));
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (probed && adminEnabled && showTokenForm) inputRef.current?.focus();
  }, [probed, adminEnabled, showTokenForm]);

  const submit = async () => {
    const t = (inputRef.current?.value || "").trim();
    if (!t) return;
    setSessionToken(t);
    const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${t}` } })
      .catch(() => null);
    if (res && res.ok) onSignedIn();
    else toast("That token didn't work", { variant: "warn" });
  };

  const hint = !probed
    ? "Checking available sign-in methods…"
    : googleEnabled
    ? (JOIN_TOKEN
      ? "You've been invited to this Agora — sign in with Google to join."
      : "Sign in with Google — members and invited emails get in.")
    : adminEnabled
      ? "Admin sign-in: paste this server's admin key (printed in its log)."
      : "No interactive sign-in method is enabled on this server. Contact its administrator.";

  return (
    <div id="auth-gate">
      <div className="auth-card">
        <div className="auth-brand"><img src="/icon.png" alt="" /><h1>Agora</h1></div>
        <p className="auth-sub" id="auth-hint">{hint}</p>
        {probed && googleEnabled && (
          <button className="btn google" id="auth-google"
            onClick={() => {
              rememberAuthPath();
              location.href = "/api/auth/google/start"
                + (JOIN_TOKEN ? "?invite=" + encodeURIComponent(JOIN_TOKEN) : "");
            }}>
            <svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
            Continue with Google
          </button>
        )}
        {googleEnabled && showTokenForm && <div className="auth-divider" id="auth-divider">or</div>}
        {probed && adminEnabled && showTokenForm && (
          <div id="auth-token-form">
            <label htmlFor="auth-token">Admin key</label>
            <input id="auth-token" ref={inputRef} type="password"
              placeholder="printed in the server log / config.json"
              autoComplete="off" autoCapitalize="off" spellCheck={false}
              onKeyDown={e => { if (e.key === "Enter") void submit(); }} />
            <button className="btn primary" onClick={() => void submit()}>Sign in as admin</button>
          </div>
        )}
        {probed && adminEnabled && googleEnabled && !showTokenForm && (
          <button className="auth-link" id="auth-token-toggle"
            onClick={() => { setShowTokenForm(true); setTimeout(() => inputRef.current?.focus(), 0); }}>
            Sign in as admin
          </button>
        )}
        <p className="auth-error" id="auth-error">{error}</p>
        <p className="auth-footer">
          New to Agora?{" "}
          <a href={WEBSITE_URL} target="_blank" rel="noreferrer">agora.kite.space</a>
        </p>
      </div>
    </div>
  );
}
