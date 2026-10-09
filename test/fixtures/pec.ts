import MailComposer from "nodemailer/lib/mail-composer";

export const build = (options: ConstructorParameters<typeof MailComposer>[0]) => new MailComposer(options).compile().build();

/** A PEC as a provider delivers it: envelope + postacert.eml + daticert.xml + signature. */
export async function samplePec(kind: "posta-certificata" | "avvenuta-consegna" = "posta-certificata"): Promise<Buffer> {
  const inner = await build({
    from: "Studio Legale Bianchi <studio.bianchi@pec.it>",
    to: "zinieliosrl@legalmail.it",
    subject: "Diffida pagamento fattura 123",
    messageId: "<inner-1@pec.it>",
    date: new Date("2026-10-08T09:15:00Z"),
    text: "Con la presente si diffida al pagamento entro 15 giorni.",
    attachments: [{ filename: "diffida.pdf", content: Buffer.from("%PDF-1.4 diffida"), contentType: "application/pdf" }],
  });
  const daticert = `<?xml version="1.0" encoding="UTF-8"?>
<postacert tipo="${kind}" errore="nessuno">
  <intestazione>
    <mittente>studio.bianchi@pec.it</mittente>
    <destinatari tipo="certificato">zinieliosrl@legalmail.it</destinatari>
    <risposte>studio.bianchi@pec.it</risposte>
    <oggetto>Diffida pagamento fattura 123 &amp; interessi</oggetto>
  </intestazione>
  <dati>
    <gestore-emittente>ARUBA PEC S.p.A.</gestore-emittente>
    <identificativo>opec210312.20261008111500.123456.789.1.53@pec.aruba.it</identificativo>
    <msgid>&lt;inner-1@pec.it&gt;</msgid>
  </dati>
</postacert>`;
  return build({
    from: "Per conto di: studio.bianchi@pec.it <posta-certificata@pec.aruba.it>",
    replyTo: "studio.bianchi@pec.it",
    to: "zinieliosrl@legalmail.it",
    subject: kind === "posta-certificata" ? "POSTA CERTIFICATA: Diffida pagamento fattura 123" : "CONSEGNA: Diffida pagamento fattura 123",
    headers: kind === "posta-certificata" ? { "X-Trasporto": "posta-certificata" } : { "X-Ricevuta": kind },
    text: "Messaggio di posta certificata\nIl giorno 08/10/2026 alle ore 11:15:00 (+0200) il messaggio è stato inviato da studio.bianchi@pec.it",
    attachments: [
      { filename: "daticert.xml", content: daticert, contentType: "application/xml" },
      ...(kind === "posta-certificata" ? [{ filename: "postacert.eml", content: inner, contentType: "message/rfc822" }] : []),
      { filename: "smime.p7s", content: Buffer.from("firma"), contentType: "application/pkcs7-signature" },
    ],
  });
}
