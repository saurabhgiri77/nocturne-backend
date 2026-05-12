// Email sender. Prefers Resend's HTTP API when RESEND_API_KEY is set —
// HTTPS:443 is universally reachable and bypasses the cloud-host outbound
// SMTP blocks that bit us on Render (Gmail/Resend both timed out on 465).
// Falls back to plain SMTP via nodemailer if Resend isn't configured, so
// anyone who wants Gmail/Brevo/SES on a non-blocked network still can.

const nodemailer = require('nodemailer');
const { Resend } = require('resend');

const FROM = process.env.EMAIL_FROM || 'Bump <onboarding@resend.dev>';

// --- Resend HTTP path (preferred) ---

let resendClient = null;
const initResend = () => {
  if (resendClient !== null) return resendClient;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    resendClient = false; // sentinel: "tried, not configured"
    return null;
  }
  resendClient = new Resend(key);
  console.log('[mailer] Resend HTTP API ready');
  return resendClient;
};

// --- SMTP fallback path ---

let transporter = null;
let smtpConfigured = false;
const initSmtp = () => {
  if (smtpConfigured) return transporter;
  smtpConfigured = true;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    // Force IPv4 — Render's outbound is IPv4-only, but Node's DNS prefers
    // AAAA records by default → instant ENETUNREACH on the first attempt.
    family: 4,
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
  });
  transporter
    .verify()
    .then(() => console.log(`[mailer] SMTP ready (${host}:${port})`))
    .catch((err) => console.error('[mailer] SMTP verify failed:', err.message));
  return transporter;
};

const sendMail = async ({ to, subject, text, html }) => {
  const r = initResend();
  if (r) {
    try {
      const { data, error } = await r.emails.send({ from: FROM, to, subject, text, html });
      if (error) throw new Error(error.message || JSON.stringify(error));
      return { messageId: data?.id };
    } catch (err) {
      // Re-throw so callers' .catch() logs the failure. Don't fall back to
      // SMTP here — Resend was explicitly configured, so an error is a real
      // signal (bad API key, sandbox-recipient restriction, etc.).
      throw err;
    }
  }

  const t = initSmtp();
  if (!t) {
    console.warn(`[mailer] would send to ${to} (${subject}) — neither Resend nor SMTP configured`);
    return { skipped: true };
  }
  const info = await t.sendMail({ from: FROM, to, subject, text, html });
  return { messageId: info.messageId };
};

const sendVerificationEmail = async ({ to, link }) => {
  const subject = 'Verify your Bump email';
  const text = `Welcome to Bump!

Confirm your email by visiting:
${link}

This link expires in 24 hours. If you didn't sign up for Bump, ignore this email.`;
  const html = `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; background:#0e0e0e; color:#fff; padding:32px;">
  <div style="max-width:480px; margin:0 auto; background:#131313; border-radius:12px; padding:32px; text-align:center;">
    <h1 style="font-size:22px; margin:0 0 8px;">Welcome to Bump</h1>
    <p style="color:#adaaaa; margin:0 0 24px;">Confirm your email to finish signing up.</p>
    <a href="${link}" style="display:inline-block; padding:12px 28px; border-radius:9999px; background:linear-gradient(135deg, #ba9eff, #8455ef); color:#000; font-weight:700; text-decoration:none;">Verify email</a>
    <p style="color:#767575; font-size:12px; margin-top:24px;">Or copy this link: <br><span style="color:#ba9eff; word-break:break-all;">${link}</span></p>
    <p style="color:#767575; font-size:11px; margin-top:32px;">This link expires in 24 hours. If you didn't sign up, ignore this email.</p>
  </div>
</body></html>`;
  return sendMail({ to, subject, text, html });
};

const sendPasswordResetEmail = async ({ to, link }) => {
  const subject = 'Reset your Bump password';
  const text = `Someone (hopefully you) asked to reset the password on your Bump account.

Use this link to set a new password:
${link}

This link expires in 1 hour. If you didn't request this, ignore this email — your password stays the same.`;
  const html = `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; background:#0e0e0e; color:#fff; padding:32px;">
  <div style="max-width:480px; margin:0 auto; background:#131313; border-radius:12px; padding:32px; text-align:center;">
    <h1 style="font-size:22px; margin:0 0 8px;">Reset your password</h1>
    <p style="color:#adaaaa; margin:0 0 24px;">Someone asked to reset the password on your Bump account. If that was you, set a new one below.</p>
    <a href="${link}" style="display:inline-block; padding:12px 28px; border-radius:9999px; background:linear-gradient(135deg, #ba9eff, #8455ef); color:#000; font-weight:700; text-decoration:none;">Set new password</a>
    <p style="color:#767575; font-size:12px; margin-top:24px;">Or copy this link: <br><span style="color:#ba9eff; word-break:break-all;">${link}</span></p>
    <p style="color:#767575; font-size:11px; margin-top:32px;">This link expires in 1 hour. If you didn't request this, ignore this email — your password stays the same.</p>
  </div>
</body></html>`;
  return sendMail({ to, subject, text, html });
};

module.exports = { sendMail, sendVerificationEmail, sendPasswordResetEmail };
