/**
 * Facebook Poster – notification mailer (Google Apps Script web app)
 *
 * Sends the approval-workflow emails via MailApp, from the Google account that deploys it
 * (same approach as the Home Instead lead-email script).
 *
 * Setup (one time, from the Google account that should send the mail):
 *   1. script.google.com → New project → paste this file.
 *   2. Project Settings → Script properties → add MAILER_SECRET = <long random string>
 *      (generate with: openssl rand -base64 32). Put the same value in Vercel as
 *      APPS_SCRIPT_MAIL_SECRET. Never commit it.
 *   3. Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone.
 *      Authorize when prompted. Copy the /exec URL into Vercel as APPS_SCRIPT_MAIL_URL.
 *   4. Optional: run testSend() once from the editor to confirm delivery.
 *
 * Note: Apps Script web apps can't read request headers, so the secret travels in the
 * JSON body (over HTTPS). Recipients are capped per call to limit abuse if it ever leaks.
 */

var MAX_RECIPIENTS = 25;
var DEFAULT_SENDER_NAME = 'Ironmark';

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var secret = PropertiesService.getScriptProperties().getProperty('MAILER_SECRET');
    if (!secret || !safeEquals_(String(body.secret || ''), secret)) {
      return json_({ ok: false, error: 'unauthorized' });
    }

    var to = cleanEmails_(body.to);
    var replyTo = cleanEmails_(body.replyTo);
    if (to.length === 0) return json_({ ok: false, error: 'no valid recipients' });
    if (to.length > MAX_RECIPIENTS) return json_({ ok: false, error: 'too many recipients' });
    if (!body.subject || !body.html) return json_({ ok: false, error: 'subject and html required' });

    if (MailApp.getRemainingDailyQuota() < to.length) {
      return json_({ ok: false, error: 'daily email quota reached' });
    }

    var message = {
      to: to.join(','),
      subject: String(body.subject).slice(0, 250),
      htmlBody: String(body.html),
      name: String(body.senderName || DEFAULT_SENDER_NAME).slice(0, 80)
    };
    if (replyTo.length) message.replyTo = replyTo.join(',');

    MailApp.sendEmail(message);
    return json_({ ok: true, remainingQuota: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'send failed' });
  }
}

function cleanEmails_(list) {
  if (!list) return [];
  if (!Array.isArray(list)) list = String(list).split(/[,;\s]+/);
  return list
    .map(function (s) { return String(s).trim().toLowerCase(); })
    .filter(function (s) { return /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(s); });
}

function safeEquals_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run from the editor to confirm the account can send. */
function testSend() {
  MailApp.sendEmail({
    to: Session.getActiveUser().getEmail(),
    subject: 'Facebook Poster mailer test',
    htmlBody: '<p>The notification mailer is working.</p>',
    name: DEFAULT_SENDER_NAME
  });
}
