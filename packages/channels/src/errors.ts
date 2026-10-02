// Turn raw IMAP/SMTP library errors into messages a non-technical owner can act on, without ever echoing a secret.
//
// The original library text is always kept (it is what you paste into a support ticket); we only append a hint when
// we recognise the failure. Hints are provider-agnostic where possible and mention the common Gmail / Microsoft 365 /
// Zoho traps (app passwords, IMAP switched off, basic auth disabled).

export type MailProtocol = "imap" | "smtp";

interface MailErrorLike {
  message?: string;
  code?: string;
  responseText?: string;
  response?: string;
  responseStatus?: string;
  responseCode?: number | string;
  authenticationFailed?: boolean;
  serverResponseCode?: string;
  command?: string;
}

/** Replace every secret (>= 3 chars) with "***". */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 3) out = out.split(s).join("***");
  return out;
}

function hintFor(err: MailErrorLike, protocol: MailProtocol, text: string): string | null {
  const code = String(err.code ?? "");
  const lower = text.toLowerCase();

  if (err.authenticationFailed || code === "EAUTH" || /authenticationfailed|invalid credentials|authentication failed|auth.*failed|login failed|535[ -]/i.test(text)) {
    return (
      `${protocol.toUpperCase()} login was rejected. Check the username (usually the full email address) and the password. ` +
      "Gmail and Zoho need an app password (not the normal password) with IMAP enabled; Microsoft 365 needs IMAP/SMTP AUTH enabled for the mailbox and often blocks basic auth. See docs/EMAIL-SETUP.md."
    );
  }
  if (/application-specific password|web login required|webalert|less secure/i.test(text)) {
    return "The provider requires an app password or a browser sign-in first. Create an app password and use it instead of the account password.";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /getaddrinfo/i.test(text)) {
    return "Host name not found. Check the host spelling and your internet/DNS connection.";
  }
  if (code === "ECONNREFUSED") {
    return "Connection refused. Check the host and port (IMAP: 993 with secure on, or 143; SMTP: 465 with secure on, or 587 with secure off + STARTTLS) and that the server allows connections from this machine.";
  }
  if (code === "ETIMEDOUT" || code === "ETIMEOUT" || code === "ECONNABORTED" || code === "GREETING_TIMEOUT" || /timed out|timeout/i.test(text)) {
    return "The server did not answer in time. Check the host/port and any firewall or VPN.";
  }
  if (code === "ECONNRESET" || code === "EPIPE" || /connection (reset|closed|not available)|socket (hang up|closed)/i.test(text)) {
    return "The connection was dropped by the server or the network. It is retried automatically.";
  }
  if (/wrong version number|ssl routines|tls.*(handshake|alert)|ERR_SSL/i.test(text)) {
    return "TLS handshake failed: the 'secure' setting does not match the port (993/465 need secure=true; 143/587 need secure=false and use STARTTLS).";
  }
  if (/self[- ]signed|unable to verify|certificate|CERT_/i.test(text) || /^(DEPTH_ZERO|UNABLE_TO_|CERT_|ERR_TLS_CERT)/.test(code)) {
    return "The server's TLS certificate is not trusted (self-signed, expired or wrong host name). Use the provider's official host name.";
  }
  if (err.responseStatus === "NO" && /nonexistent|doesn't exist|does not exist|no such mailbox|unknown mailbox|trycreate/i.test(lower)) {
    return "That mailbox/folder does not exist on the server (names are case- and language-sensitive; run `hq email doctor` to list the real ones).";
  }
  if (/imap.*(disabled|not enabled)|access to .*imap|imap access/i.test(text)) {
    return "IMAP access appears to be switched off for this mailbox. Enable IMAP in the mail provider's settings.";
  }
  return null;
}

/** "<protocol>: <original text> [(server detail)] — <hint>", secret-free and capped at ~600 chars. */
export function describeMailError(err: unknown, protocol: MailProtocol, secrets: readonly string[] = []): string {
  const e = (err && typeof err === "object" ? err : { message: String(err) }) as MailErrorLike;
  const base = e.message || String(err);
  const detail = e.responseText || (typeof e.response === "string" ? e.response : "");
  let text = detail && !base.includes(detail) ? `${base} (${detail})` : base;
  const hint = hintFor(e, protocol, `${text} ${e.serverResponseCode ?? ""}`);
  if (hint) text = `${text} - ${hint}`;
  text = scrubSecrets(text, secrets);
  return text.length > 600 ? `${text.slice(0, 597)}...` : text;
}

/** True for errors that are a definitive answer from the server (retrying the same command will not help). */
export function isDefinitiveServerError(err: unknown): boolean {
  const e = (err && typeof err === "object" ? err : {}) as MailErrorLike;
  if (e.authenticationFailed) return true;
  return e.responseStatus === "NO" || e.responseStatus === "BAD";
}
