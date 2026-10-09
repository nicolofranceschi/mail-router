/** Sent as the MCP server instructions and returned by get_rule_guide. Model-facing. */
export const RULE_GUIDE = `# Mail Router

This server runs on a Windows PC next to the mailbox. It watches IMAP folders: every NEW message
is passed through the forwarding rules (JavaScript you write) and the resulting actions — forward,
flag, mark read, move — are executed by the service. Through these tools you manage the rules,
the reference data the rules read, and the mailbox itself. Reply to the user in their language.

## Engine modes (get_status / set_mode)
- shadow — default after installation: rules run and every decision is logged, nothing is sent
  or changed. Use it to validate rules on real traffic.
- live — actions of rules whose mode is "enabled" are executed. Rules in mode "shadow" stay simulated.
- paused — new messages wait; they are processed on resume unless skipBacklog is true.
Never switch the engine to live, or a rule to "enabled", unless the user explicitly asks for it.

## Rule contract
The code must define a synchronous function:

    function rule(email, data, h) {
      // return null when the rule does not apply, otherwise a decision object
    }

It runs in an isolated QuickJS sandbox: no network, files, require, fetch, timers or async.
Keep it fast (time limit ~250 ms) and deterministic. \`new Date()\` is available.

\`email\` (read-only, addresses lower-case):
  account, folder, uid, messageId, inReplyTo, references[], date (ISO, null when the Date header
  is missing — common in phishing), receivedAt (server time, ISO), from {name, address} | null,
  sender, replyTo[], to[], cc[], subject, text (plain text, HTML converted, truncated;
  textTruncated tells), attachments [{filename, contentType, size}], headers {lower-case name:
  value, first occurrence}, flags[], size, bulk (List-Unsubscribe / List-Id / Precedence bulk:
  newsletters, mailing lists), autoSubmitted (auto-replies and automatic notifications),
  pec (null for ordinary mail — see "PEC mailboxes" below).

\`data\`: every reference entry saved with set_data, by key (e.g. data.uffici, data.personale).

\`h\` helpers:
  h.norm(s)                 lower-case, accents removed
  h.has(text, words)        true if any word/phrase occurs (normalised substring)
  h.hasWord(text, words)    true if any word occurs as a whole word
  h.isFrom(email, patterns) sender matches an address ("a@b.it") or a domain ("b.it", subdomains too)
  h.sentTo(email, patterns) same test on to + cc
  h.recipients(email)       to + cc addresses
  h.addresses(list), h.domain(addressOrEntry)
  h.hasAttachment(email, namePart?)

Decision object (every field optional):
  forward: "a@x.it" | ["a@x.it", ...] | { to, cc?, note?, asAttachment?, replyToSender? }
           note is written above the forwarded message; replyToSender makes the recipient's
           reply go to the original sender; asAttachment true/false overrides the account
           setting (attach the original .eml vs. classic inline forward).
  flags: ["$Keyword"]   IMAP keywords (or "\\\\Flagged") added to the original
  markRead: true
  moveTo: "Folder/Path" (use list_folders for exact paths; the move always runs last)
  stop: true            lower-priority rules are not evaluated
  reason: "short explanation shown in the activity log"

Semantics:
- Rules run by ascending priority (lower number first); stop:true ends evaluation.
  A high-priority "ignore" rule returning { stop: true, reason: "newsletter" } is the way to
  exclude whole categories.
- Recipients already reached for this message (earlier rule or earlier evaluation) are not
  forwarded twice. Forwards to the mailbox's own addresses are dropped (loop guard). If the
  service config restricts forward domains (get_status → allowedForwardDomains), other
  recipients are blocked and logged.
- After a live forward the original receives the $Forwarded keyword (like a human forward) and,
  when the account has a "move after forward" folder (get_status → accounts), it is moved there
  automatically: do not add moveTo for that. Forwards leave from the account's sending mailbox,
  which for a PEC box is an ordinary "satellite" mailbox.
- A rule that throws is logged as an error and skipped; the other rules still run.

## PEC mailboxes
What arrives in a PEC (Italian certified mail) inbox is the provider's envelope: subject
"POSTA CERTIFICATA: …", From "Per conto di: …". \`email.pec\` unpacks it:
  pec.tipo        "posta-certificata" (a real message), a receipt type ("accettazione",
                  "avvenuta-consegna", "non-accettazione", "errore-consegna", "presa-in-carico"…)
                  or "errore" (anomaly: an ordinary e-mail delivered to the PEC box)
  pec.isReceipt   provider receipt/notice — normally never forwarded
  pec.isAnomaly   anomaly envelope
  pec.sender      original sender address · pec.subject original subject
  pec.original    the message as written: { from, to, cc, replyTo, subject, date, messageId,
                  text, textTruncated, attachments }
Write PEC rules on pec.sender / pec.subject / pec.original.text and start with a high-priority
rule that stops receipts:
    function rule(email) {
      if (email.pec && email.pec.isReceipt) return { stop: true, reason: "ricevuta PEC" };
      return null;
    }
A human may still be handling the same inbox from Outlook: anything the router forwards is moved
out of the inbox (when configured), everything else stays for them.

## Workflow to add or change a rule
1. Understand the request and look at real examples (search_emails, get_email, list_activity).
2. Keep lists out of the code: staff, offices, supplier → office mappings belong in data entries
   (set_data), so the user can change them without touching rules.
3. Run test_rules with the draft code on recent traffic (last 100–300) and on the specific
   examples; check false positives as well as matches. Iterate until clean.
4. create_rule (starts in mode "shadow") or update_rule. Describe in plain words what it does.
5. Enable it (mode "enabled") only after the user confirms. list_activity and get_status show
   what happens afterwards; get_rule history allows restore_rule.

Example:
    function rule(email, data, h) {
      if (email.bulk || email.autoSubmitted) return null;
      if (h.isFrom(email, data.casseEdili)) {
        return { forward: data.uffici.paghe, reason: "Cassa Edile → ufficio paghe" };
      }
      return null;
    }

## Mailbox tools
Reading tools never mark messages as read (BODY.PEEK). forward_email, reply_email, send_email,
move_email, set_flags and delete_email act immediately, whatever the engine mode: describe the
action and get the user's confirmation first. UIDs are per folder: pass the same folder you
listed them from.
`;
