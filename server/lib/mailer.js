const nodemailer = require('nodemailer');

// Provider-agnostic transporter. Reads SMTP_HOST / SMTP_PORT / SMTP_USER /
// SMTP_PASS / EMAIL_FROM from env. Works with Gmail, Resend, Brevo, SES,
// or any plain-SMTP server. Defaults below match Gmail SMTP (the easiest
// free starter — needs an App Password generated at
// https://myaccount.google.com/apppasswords).
//
// If SMTP_HOST is unset, sendMail() becomes a no-op + logs a warning so
// dev environments (and tests) don't crash. Production should always
// have these set.

let transporter = null;
let configured = false;

const init = () => {
  if (configured) return transporter;
  configured = true;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.warn('[mailer] SMTP_HOST/USER/PASS not set — email sending disabled');
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 465 = TLS, 587 = STARTTLS (most common for Gmail)
    auth: { user, pass },
  });
  return transporter;
};

const FROM = process.env.EMAIL_FROM || 'Nocturne <noreply@nocturne.app>';

const sendMail = async ({ to, subject, text, html }) => {
  const t = init();
  if (!t) {
    console.warn(`[mailer] would send to ${to} (${subject}) — but transporter not configured`);
    return { skipped: true };
  }
  const info = await t.sendMail({ from: FROM, to, subject, text, html });
  return { messageId: info.messageId };
};

const sendVerificationEmail = async ({ to, link }) => {
  const subject = 'Verify your Nocturne email';
  const text = `Welcome to Nocturne!

Confirm your email by visiting:
${link}

This link expires in 24 hours. If you didn't sign up for Nocturne, ignore this email.`;
  const html = `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; background:#0e0e0e; color:#fff; padding:32px;">
  <div style="max-width:480px; margin:0 auto; background:#131313; border-radius:12px; padding:32px; text-align:center;">
    <h1 style="font-size:22px; margin:0 0 8px;">Welcome to Nocturne</h1>
    <p style="color:#adaaaa; margin:0 0 24px;">Confirm your email to finish signing up.</p>
    <a href="${link}" style="display:inline-block; padding:12px 28px; border-radius:9999px; background:linear-gradient(135deg, #ba9eff, #8455ef); color:#000; font-weight:700; text-decoration:none;">Verify email</a>
    <p style="color:#767575; font-size:12px; margin-top:24px;">Or copy this link: <br><span style="color:#ba9eff; word-break:break-all;">${link}</span></p>
    <p style="color:#767575; font-size:11px; margin-top:32px;">This link expires in 24 hours. If you didn't sign up, ignore this email.</p>
  </div>
</body></html>`;
  return sendMail({ to, subject, text, html });
};

module.exports = { sendMail, sendVerificationEmail };
