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
