/** The read-only view of a message that rule code receives as `email`. */
export interface RuleAddress {
  name: string;
  address: string;
}

export interface RuleAttachment {
  filename: string;
  contentType: string;
  size: number;
}

export interface RuleEmail {
  account: string;
  folder: string;
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** Date header, ISO 8601 (null when missing — a phishing tell). */
  date: string | null;
  /** When the server received it (IMAP INTERNALDATE), ISO 8601. */
  receivedAt: string | null;
  from: RuleAddress | null;
  sender: RuleAddress | null;
  replyTo: RuleAddress[];
  to: RuleAddress[];
  cc: RuleAddress[];
  subject: string;
  /** Plain-text body (HTML converted), truncated to engine.maxTextChars. */
  text: string;
  textTruncated: boolean;
  attachments: RuleAttachment[];
  /** Lower-cased header names, first occurrence, values unfolded and capped. */
  headers: Record<string, string>;
  flags: string[];
  size: number;
  /** List-Unsubscribe / List-Id / Precedence bulk|list|junk present. */
  bulk: boolean;
  /** Auto-Submitted present and not "no" (auto-replies, notifications). */
  autoSubmitted: boolean;
  /** Certified mail (PEC) details, null for ordinary mail. */
  pec: RulePec | null;
}

export interface RulePec {
  /** "posta-certificata" for a message, a receipt type ("accettazione", "avvenuta-consegna"…) or "errore". */
  tipo: string;
  /** Receipt or notice from the PEC provider, not a message written by someone. */
  isReceipt: boolean;
  /** Anomaly envelope: an ordinary (non-PEC) message delivered to the PEC box. */
  isAnomaly: boolean;
  /** Original sender (from daticert.xml or the inner message), lower-case. */
  sender: string | null;
  /** Original subject, without the "POSTA CERTIFICATA:" prefix. */
  subject: string | null;
  identificativo: string | null;
  gestore: string | null;
  /** The message as its author wrote it (postacert.eml). */
  original: {
    from: RuleAddress | null;
    to: RuleAddress[];
    cc: RuleAddress[];
    replyTo: RuleAddress[];
    subject: string;
    date: string | null;
    messageId: string | null;
    text: string;
    textTruncated: boolean;
    attachments: RuleAttachment[];
  } | null;
}
