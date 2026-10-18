import { useState } from "react";
import { supabase } from "../lib/supabase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function send(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setBusy(true);
    // Invite-only: shouldCreateUser=false means only people the owner has invited can get a code.
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false } });
    setBusy(false);
    if (error) setErr(/signups not allowed|not found|Signups/i.test(error.message) ? "This beta is invite-only. Ask the owner to invite this email." : error.message);
    else setSent(true);
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setBusy(true);
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    setBusy(false);
    if (error) setErr(error.message.includes("expired") ? "That code has expired. Send a new one." : "That code didn't work. Check it and try again.");
  }

  return (
    <div className="wrap narrow">
      <header>
        <div>
          <div className="eyebrow">the job-hunt notebook</div>
          <h1>Job Hunter</h1>
          <div className="sub">Fresh roles from 170+ company career pages and job boards, matched to your resume, with referral paths from your LinkedIn.</div>
        </div>
      </header>
      <div className="panel">
        <h2>{sent ? "Check your inbox" : "Sign in"}</h2>
        {!sent ? (
          <form onSubmit={send}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            <button className="btn" disabled={busy}>{busy ? "Sending…" : "Email me a code"}</button>
            <p className="hint">No passwords. We email you a 6-digit code each time you sign in.</p>
          </form>
        ) : (
          <form onSubmit={verify}>
            <p>We sent a code to <b>{email}</b>.</p>
            <div className="field">
              <label htmlFor="code">6-digit code</label>
              <input id="code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={e => setCode(e.target.value)} placeholder="123456" />
            </div>
            <div className="row">
              <button className="btn" disabled={busy}>{busy ? "Checking…" : "Sign in"}</button>
              <button type="button" className="linkbtn" onClick={() => { setSent(false); setCode(""); }}>Use a different email</button>
            </div>
          </form>
        )}
        {err && <p className="err">{err}</p>}
      </div>
    </div>
  );
}
