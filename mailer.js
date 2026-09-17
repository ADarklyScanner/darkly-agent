/**
 * mailer.js — one small, reusable way to send email through the account's
 * own Gmail credentials.
 *
 * Factored out of the inline nodemailer call that used to live only in
 * server.js's /send-email handler, which sends ReferralMarket outreach to
 * a lead. That handler deliberately locks itself to one exact address
 * (REQUIRED_GMAIL = "referralmarket.site@gmail.com") — it is a
 * customer-facing send, and the lock exists so a lead can never be
 * emailed from the wrong identity by a config mistake.
 *
 * A personal system alert (what this file is for — see alerts.js) is not
 * customer outreach and has no reason to inherit that lock. It sends from
 * whatever GMAIL_USER/GMAIL_APP_PASSWORD are already configured for
 * outbound mail, to a separate, opt-in ALERT_EMAIL_TO destination. Until
 * ALERT_EMAIL_TO is deliberately set, alerting stays off — silence should
 * never mean "and it emailed someone I didn't choose."
 */

/** Whether there's a configured destination and credentials for alerts to
 * actually send. Checked before dispatch so an unconfigured alert path
 * fails silent-and-obvious rather than throwing from inside a trading run. */
export function alertingConfigured() {
  return Boolean(
    String(process.env.GMAIL_USER || "").trim() &&
      process.env.GMAIL_APP_PASSWORD &&
      String(process.env.ALERT_EMAIL_TO || "").trim()
  );
}

// Test seam: nodemailer is a real network-capable package, not something
// tests should have to install or actually connect with. Left null, the
// real package is used (dynamically imported, same as the pre-existing
// /send-email handler in server.js); tests substitute a stub factory here
// so this file's own logic — argument shaping, error handling — can be
// verified without a live SMTP dependency.
let _transportFactory = null;

/** Test-only: override how a Gmail transport is created. Pass null to
 * restore the real nodemailer-backed transport. */
export function _setTransportFactoryForTests(factory) {
  _transportFactory = factory;
}

async function createGmailTransport(user, password) {
  if (_transportFactory) return _transportFactory({ user, password });
  const { createTransport } = await import("nodemailer");
  return createTransport({ service: "gmail", auth: { user, pass: password } });
}

/**
 * Send one plain-text email via Gmail. Generic — callers decide `to`,
 * `subject`, `text`. Throws on missing credentials or a send failure;
 * callers that must never throw (like the alert path) catch this
 * themselves rather than this function pretending success.
 */
export async function sendMail({ to, subject, text }) {
  const user = String(process.env.GMAIL_USER || "").trim();
  const password = process.env.GMAIL_APP_PASSWORD;

  if (!user) throw new Error("GMAIL_USER is not configured");
  if (!password) throw new Error("GMAIL_APP_PASSWORD is not configured");
  if (!to) throw new Error("sendMail requires a 'to' address");

  const transporter = await createGmailTransport(user, password);
  const info = await transporter.sendMail({ from: user, to, subject, text });
  return { ok: true, messageId: info?.messageId || null };
}

/**
 * Send to the configured alert destination (ALERT_EMAIL_TO), never
 * throwing — callers on a background/scheduled path (autotrader.js) need
 * a result object, not an exception mid-run. Returns
 * {ok:false, reason} rather than sending nowhere when unconfigured.
 */
export async function sendAlertMail({ subject, text }) {
  if (!alertingConfigured()) {
    return {
      ok: false,
      reason:
        "Alert email is not configured. Set GMAIL_USER, GMAIL_APP_PASSWORD, and ALERT_EMAIL_TO to enable it."
    };
  }

  const to = String(process.env.ALERT_EMAIL_TO || "").trim();

  try {
    const result = await sendMail({ to, subject, text });
    return result;
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}
