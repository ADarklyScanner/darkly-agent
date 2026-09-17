/**
 * Tests for mailer.js — run with: node mailer.test.mjs
 *
 * The one thing worth pinning here beyond "it builds the right transport
 * call": this path must NEVER be governed by the ReferralMarket
 * REQUIRED_GMAIL lock (that lock is scoped to customer outreach in
 * server.js's /send-email handler, not to this file), and it must stay
 * silent — not throw, not send to a default address — until
 * ALERT_EMAIL_TO is deliberately set.
 *
 * The real nodemailer package isn't installed in every environment this
 * runs in, and shouldn't need to be for a unit test — mailer.js exposes
 * _setTransportFactoryForTests() as a seam so the actual network client
 * is swapped out, the same way other tests in this project stub fetch.
 */

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const k of ["GMAIL_USER", "GMAIL_APP_PASSWORD", "ALERT_EMAIL_TO"]) {
    delete process.env[k];
  }
}

let pass = 0;
let fail = 0;

function check(label, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

const {
  alertingConfigured,
  sendMail,
  sendAlertMail,
  _setTransportFactoryForTests
} = await import("./mailer.js");

/* ------------------------------------------------------------------ */

console.log("\nalertingConfigured — opt-in, not on by default");

resetEnv();
check("nothing set: not configured", alertingConfigured() === false);

resetEnv();
process.env.GMAIL_USER = "someone@gmail.com";
process.env.GMAIL_APP_PASSWORD = "app-password";
check("Gmail creds alone (no ALERT_EMAIL_TO) is still NOT configured",
  alertingConfigured() === false);

resetEnv();
process.env.ALERT_EMAIL_TO = "me@example.com";
check("ALERT_EMAIL_TO alone (no Gmail creds) is still NOT configured",
  alertingConfigured() === false);

resetEnv();
process.env.GMAIL_USER = "someone@gmail.com";
process.env.GMAIL_APP_PASSWORD = "app-password";
process.env.ALERT_EMAIL_TO = "me@example.com";
check("all three set: configured", alertingConfigured() === true);

resetEnv();
process.env.GMAIL_USER = "  someone@gmail.com  ";
process.env.GMAIL_APP_PASSWORD = "app-password";
process.env.ALERT_EMAIL_TO = "  me@example.com  ";
check("whitespace-only-padded values still count as set", alertingConfigured() === true);

/* ------------------------------------------------------------------ */

console.log("\nsendMail — no ReferralMarket lock, real errors on missing config");

resetEnv();
{
  let threw = null;
  try { await sendMail({ to: "x@y.com", subject: "s", text: "t" }); } catch (e) { threw = e; }
  check("throws plainly when GMAIL_USER is missing", threw && /GMAIL_USER/.test(threw.message), threw?.message);
}

resetEnv();
process.env.GMAIL_USER = "anything@gmail.com"; // deliberately NOT referralmarket.site@gmail.com
{
  let threw = null;
  try { await sendMail({ to: "x@y.com", subject: "s", text: "t" }); } catch (e) { threw = e; }
  check("a non-ReferralMarket GMAIL_USER is never rejected for identity — only missing password",
    threw && /GMAIL_APP_PASSWORD/.test(threw.message), threw?.message);
}

resetEnv();
process.env.GMAIL_USER = "anything@gmail.com";
process.env.GMAIL_APP_PASSWORD = "app-password";
{
  let threw = null;
  try { await sendMail({ subject: "s", text: "t" }); } catch (e) { threw = e; }
  check("throws when 'to' is missing", threw && /'to'/.test(threw.message), threw?.message);
}

/* ------------------------------------------------------------------ */

console.log("\nsendMail — the actual send (transport factory stubbed)");

resetEnv();
process.env.GMAIL_USER = "sender@gmail.com";
process.env.GMAIL_APP_PASSWORD = "app-password";
{
  const calls = [];
  _setTransportFactoryForTests(({ user, password }) => {
    calls.push({ user, password });
    return {
      sendMail: async (msg) => {
        calls.push({ msg });
        return { messageId: "abc123" };
      }
    };
  });

  try {
    const result = await sendMail({ to: "dest@example.com", subject: "Hi", text: "Body" });
    check("result reports ok:true", result.ok === true);
    check("result carries the messageId", result.messageId === "abc123", JSON.stringify(result));
    check("transport is created with GMAIL_USER", calls[0].user === "sender@gmail.com");
    check("transport is created with GMAIL_APP_PASSWORD", calls[0].password === "app-password");
    check("mail is sent from GMAIL_USER, not a hardcoded address", calls[1].msg.from === "sender@gmail.com");
    check("mail goes to the requested recipient", calls[1].msg.to === "dest@example.com");
    check("subject/text pass through untouched",
      calls[1].msg.subject === "Hi" && calls[1].msg.text === "Body");
  } finally {
    _setTransportFactoryForTests(null);
  }
}

/* ------------------------------------------------------------------ */

console.log("\nsendAlertMail — never throws, stays silent until configured");

resetEnv();
{
  const result = await sendAlertMail({ subject: "s", text: "t" });
  check("unconfigured: returns ok:false rather than throwing", result.ok === false);
  check("explains what to set", /ALERT_EMAIL_TO/.test(result.reason), result.reason);
}

resetEnv();
process.env.GMAIL_USER = "sender@gmail.com";
process.env.GMAIL_APP_PASSWORD = "app-password";
process.env.ALERT_EMAIL_TO = "alerts@example.com";
{
  let sentTo = null;
  _setTransportFactoryForTests(() => ({
    sendMail: async (msg) => {
      sentTo = msg.to;
      return { messageId: "xyz" };
    }
  }));

  try {
    const result = await sendAlertMail({ subject: "Alert!", text: "Something happened" });
    check("configured: sends and reports ok:true", result.ok === true, JSON.stringify(result));
    check("sends to ALERT_EMAIL_TO specifically", sentTo === "alerts@example.com", sentTo);
  } finally {
    _setTransportFactoryForTests(null);
  }
}

resetEnv();
process.env.GMAIL_USER = "sender@gmail.com";
process.env.GMAIL_APP_PASSWORD = "app-password";
process.env.ALERT_EMAIL_TO = "alerts@example.com";
{
  _setTransportFactoryForTests(() => ({
    sendMail: async () => {
      throw new Error("SMTP exploded");
    }
  }));

  try {
    const result = await sendAlertMail({ subject: "Alert!", text: "Something happened" });
    check("a send failure is caught and reported, not thrown", result.ok === false);
    check("the failure reason is preserved", /SMTP exploded/.test(result.reason), result.reason);
  } finally {
    _setTransportFactoryForTests(null);
  }
}

process.env = ORIGINAL_ENV;

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
