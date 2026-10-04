export type { EmailProviderConfig } from "./config.ts";
export { createEmailProvider } from "./config.ts";

export { parseRawEmail } from "./parse.ts";
export { extractReplyText } from "./reply-text.ts";
export { classifyEmail } from "./classify.ts";
export type { ClassifyOptions } from "./classify.ts";
export { newMessageId, normalizeMessageId } from "./message-id.ts";

export { FakeEmailProvider } from "./providers/fake.ts";
export { MaildirProvider } from "./providers/maildir.ts";
export type { MaildirProviderOptions } from "./providers/maildir.ts";
export { ImapSmtpProvider } from "./providers/imap-smtp.ts";
export type {
  ImapClient,
  ImapClientFactory,
  ImapClientFetchMessage,
  ImapClientMailbox,
  ImapConnectionConfig,
  ImapSmtpProviderOptions,
  SmtpTransportFactory,
} from "./providers/imap-smtp.ts";
export { describeMailError, scrubSecrets, isDefinitiveServerError } from "./errors.ts";
export type { MailProtocol } from "./errors.ts";
export {
  DEFAULT_SYNC_POLICY,
  formatImapCursor,
  parseImapCursor,
  pickSentFolder,
  resolveStartUid,
} from "./providers/imap-sync.ts";
export type { FolderInfo, ImapCursor, SentFolderResult, StartPlan, SyncPolicy } from "./providers/imap-sync.ts";
export { runMailboxDoctor, DOCTOR_WINDOWS_DAYS } from "./doctor.ts";
export type { DoctorSample, DoctorStep, MailboxDoctorOptions, MailboxDoctorReport } from "./doctor.ts";

// Facebook Page channel (docs/FANPAGE.md)
export type { FacebookProviderConfig, FacebookProviderDeps } from "./facebook-config.ts";
export { createFacebookProvider, DEFAULT_FACEBOOK_TOKEN_ENV } from "./facebook-config.ts";
export { FakeFacebookProvider } from "./providers/facebook-fake.ts";
export type { FakeFacebookOptions } from "./providers/facebook-fake.ts";
export { GraphApiFacebookProvider } from "./providers/facebook-graph.ts";
export type { GraphApiProviderOptions } from "./providers/facebook-graph.ts";
export { FacebookError, FacebookScheduleWindowError, classifyGraphError, describeFacebookError, isTransientFacebookError } from "./facebook-errors.ts";
export type { FacebookErrorCode, FacebookErrorInfo } from "./facebook-errors.ts";
export { FACEBOOK_APP_SECRET_ENV, appSecretProof, verifyWebhookSignature } from "./facebook-signature.ts";
export { FB_SCHEDULE_MAX_MS, FB_SCHEDULE_MIN_MS, validateScheduleWindow } from "./facebook-schedule.ts";
