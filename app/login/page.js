"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "../../utils/supabase/client";

const C = {
  bg: "#060A14",
  panel: "#0B1222",
  raised: "#101A30",
  line: "#1B2A44",
  text: "#EAF4FF",
  muted: "#8FA3C0",
  faint: "#54688A",
  cyan: "#38E1FF",
  cyanDim: "#1E7E96",
};

function emailProblem(email) {
  const e = (email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return "That email doesn't look right.";
  return null;
}

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [optIn, setOptIn] = useState(true);

  const submit = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      if (mode === "signup") {
        const problem = emailProblem(email);
        if (problem) { setErr(problem); setBusy(false); return; }

        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: window.location.origin + "/auth/confirm",
            data: { marketing_opt_in: optIn },
          },
        });
        if (error) throw error;
        setMsg("Account created. Check your email to confirm your account, then log in.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push("/");
        router.refresh();
      }
    } catch (e) {
      setErr((e && e.message) || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setErr(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + "/auth/callback" },
    });
    if (error) setErr(error.message);
  };

  return (
    <div
      style={{ background: C.bg, color: C.text, minHeight: "100vh", fontFamily: "Inter, system-ui, sans-serif" }}
      className="flex items-center justify-center px-4"
    >
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600&display=swap');`}</style>

      <div
        style={{ background: C.panel, border: "1px solid " + C.line, width: "100%", maxWidth: 400, boxShadow: "0 0 60px -30px rgba(56,225,255,0.35)" }}
        className="rounded-2xl p-7"
      >
        <div className="text-center mb-6">
          <div
            style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, letterSpacing: 0.5 }}
            className="text-xl"
          >
            FIRST TAKE <span style={{ color: C.cyan }}>HUMANIZER</span>
          </div>
          <div style={{ color: C.faint, fontSize: 12 }} className="mt-1">
            Your track goes in machine, comes out musician.
          </div>
        </div>

        <button
          onClick={google}
          style={{ background: "#FFFFFF", color: "#1a1a1a", fontWeight: 600 }}
          className="w-full rounded-xl py-2.5 mb-5 flex items-center justify-center gap-2 transition select-none"
        >
          <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
          Continue with Google
        </button>

        <div style={{ color: C.faint, fontSize: 11 }} className="text-center mb-4">or use email</div>

        <div style={{ background: C.bg, border: "1px solid " + C.line }} className="rounded-xl p-1 flex gap-1 mb-5">
          {["login", "signup"].map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setErr(null); setMsg(null); }}
              style={{ background: mode === m ? C.cyan : "transparent", color: mode === m ? "#06121a" : C.muted, fontWeight: 700 }}
              className="flex-1 rounded-lg py-2 text-sm transition"
            >
              {m === "login" ? "Log in" : "Sign up"}
            </button>
          ))}
        </div>

        <label style={{ color: C.faint, fontSize: 12 }} className="block mb-1">Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ background: C.bg, color: C.text, border: "1px solid " + C.line, outline: "none" }}
          className="w-full rounded-lg px-3 py-2 mb-4"
          placeholder="you@email.com"
        />

        <label style={{ color: C.faint, fontSize: 12 }} className="block mb-1">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ background: C.bg, color: C.text, border: "1px solid " + C.line, outline: "none" }}
          className="w-full rounded-lg px-3 py-2 mb-5"
          placeholder="••••••••"
        />

        {mode === "signup" && (
          <label className="flex items-start gap-2 mb-5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={optIn}
              onChange={(e) => setOptIn(e.target.checked)}
              style={{ accentColor: C.cyan, marginTop: 3 }}
            />
            <span style={{ color: C.muted, fontSize: 12 }}>
              Send me tips and product updates from First Take Audio. You can unsubscribe anytime.
            </span>
          </label>
        )}

        <button
          suppressHydrationWarning
          onClick={submit}
          disabled={busy || !email || !password}
          style={{ background: C.cyan, color: "#06121a", fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, opacity: busy || !email || !password ? 0.6 : 1 }}
          className="w-full rounded-xl py-3 transition select-none"
        >
          {busy ? "Working…" : mode === "login" ? "Log in" : "Create account"}
        </button>

        {msg && <p style={{ color: C.cyan, fontSize: 13 }} className="mt-4 text-center">{msg}</p>}
        {err && <p style={{ color: "#FF7A6B", fontSize: 13 }} className="mt-4 text-center">{err}</p>}

        <p style={{ color: C.faint, fontSize: 11 }} className="mt-5 text-center">
          One account for{" "}
          <a href="https://firsttakeaudio.com" style={{ color: C.cyan, textDecoration: "underline" }}>
            Music Forge
          </a>{" "}
          and the Humanizer.
        </p>
      </div>
    </div>
  );
}
