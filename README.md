# Mail Router

Servizio Windows in background che sorveglia una casella IMAP e **inoltra in automatico** la
posta secondo regole scritte in codice da Claude. Ha un **pannello di controllo** (finestra sul PC
o browser dalla rete) e un **server MCP**: dal tuo PC colleghi Claude e, parlando in italiano,
aggiungi, modifichi o togli regole e gestisci la casella (leggi, cerchi, inoltri, rispondi,
sposti, segni, elimini).

```
 Server di posta (IMAP/SMTP)
          ▲  IDLE + polling, lettura senza segnare come letto
          │
 ┌────────┴──────── PC Windows in ufficio ─────────────────────┐
 │ mail-router.exe (attività pianificata, utente SYSTEM)       │
 │   monitor IMAP → regole JS in sandbox QuickJS → decisione  │
 │   coda azioni (inoltro, flag, letto, sposta) con retry     │
 │   SQLite: regole + versioni, dati, storico, coda           │
 │   pannello :8787/ + server MCP :8787/mcp (chiave, rete loc.)│
 └────────▲────────────────────────────────────────────────────┘
          │  LAN / VPN
     Claude Code sul tuo PC
```

## Come funziona

- **Solo i messaggi nuovi.** Al primo avvio il servizio memorizza l'ultimo UID della cartella e
  da lì in avanti valuta ogni messaggio in arrivo, una volta sola (anche dopo riavvii).
- **Regole = codice.** Ogni regola è una funzione JavaScript `rule(email, data, h)` che restituisce
  `null` oppure una decisione (`forward`, `flags`, `markRead`, `moveTo`, `stop`, `reason`). Gira in
  una sandbox QuickJS/WebAssembly senza rete, file o processi, con limiti di tempo e memoria:
  una regola sbagliata non può fare danni né fermare le altre.
- **Dati separati dal codice.** Elenchi che cambiano (uffici, persone, fornitori) stanno nei
  «dati di riferimento» (`set_data`), che ogni regola riceve come `data`.
- **Prima si osserva, poi si agisce.** Il motore parte in modalità **ombra**: valuta e registra
  ogni decisione senza inviare nulla. Le nuove regole nascono anch'esse in ombra. Si passa a
  **live** solo quando lo chiedi tu.
- **Inoltro come lo farebbe una persona.** «I: oggetto», nota opzionale in testa, intestazione
  «Messaggio inoltrato», allegati e immagini incorporate, flag `$Forwarded` sull'originale,
  copia nella cartella Inviati (se configurata). Mai due volte agli stessi destinatari.
- **Protezioni.** Domini ammessi per gli inoltri automatici (`outbound.allowedDomains`),
  nessun inoltro verso la casella stessa, i messaggi generati dal router non vengono rielaborati,
  il token MCP è conservato solo come hash, l'endpoint accetta solo reti private.

## Caselle PEC

Una PEC si sorveglia come qualsiasi casella, ma va configurata così (la procedura guidata lo
propone da sola se il server sembra una PEC):

- **Inoltro da una casella satellite.** Nel passo «Inoltro» scegli «Da un'altra casella
  (satellite)». È una casella normale che serve solo a inviare, così gli inoltri non partono
  come PEC.
- **Messaggio originale allegato (.eml).** Il destinatario riceve la PEC intera, con busta,
  `postacert.eml` e firma del gestore, più un riepilogo: mittente PEC, oggetto e data
  originali, allegati, identificativo.
- **Dopo l'inoltro sposta in «Inoltrate».** Viene spostata solo una PEC inoltrata con
  successo; la cartella viene creata se manca. Chi continua a lavorare la casella a mano
  trova in arrivo solo quello che resta da fare.

Le regole vedono la PEC «aperta» in `email.pec`:
- il tipo: messaggio, ricevuta di accettazione o consegna, anomalia;
- mittente e oggetto originali;
- testo e allegati di `postacert.eml`.

Le ricevute si escludono con una regola ad alta priorità; la guida che Claude riceve dal
server MCP lo spiega.

## Installazione su Windows

Serve un PC sempre acceso che raggiunga il server di posta (anche l'SMTP, se l'invio è
consentito solo dalla rete d'ufficio).

1. Copia `mail-router.exe` sul PC e aprilo con **doppio clic**. Windows chiede di confermare i
   permessi di amministratore.
2. Si apre la **procedura guidata**, che chiede:
   - un nome per il servizio;
   - la casella (server, utente, password, con prova di accesso);
   - le cartelle da sorvegliare;
   - l'invio (con prova);
   - i domini a cui le regole possono inoltrare.

   Poi premi **Installa e avvia**.
3. Alla fine compare **una sola volta** la chiave di accesso, con il comando per collegare
   Claude: copiali. Il pulsante successivo apre il pannello.

L'installazione:
- copia il programma in `C:\Program Files\MailRouter`;
- crea l'attività pianificata `MailRouter` (all'avvio di Windows, utente SYSTEM, riavvio automatico);
- apre la porta del pannello e di MCP (8787) nel firewall solo per la rete locale;
- limita `C:\ProgramData\MailRouter` ad amministratori e SYSTEM;
- mette il collegamento **Mail Router** sul Desktop e nel menu Start.

Le password sono cifrate con DPAPI e si possono decifrare solo su quel PC.

## Il pannello

Dal collegamento sul Desktop (conferma di amministratore, nessuna chiave da digitare) oppure da
qualsiasi computer della rete all'indirizzo `http://IP-DEL-PC:8787/`, inserendo la chiave di
accesso. Le sezioni:

- **Panoramica**: modalità, cartelle collegate, coda di invio, ultimi messaggi.
- **Regole**: codice, priorità, accensione (attiva / in prova / spenta), prova sulle ultime
  mail vere, cronologia con ripristino.
- **Attività**: per ogni messaggio le regole applicate e le azioni (fatto, in coda, errore,
  simulato, bloccato), con «Riprova» per quelle non riuscite.
- **Posta**: elenco e ricerca, lettura senza segnare come letto, inoltra, sposta, elimina e
  «Prova le regole» su un messaggio.
- **Dati di riferimento**: gli elenchi che le regole leggono (uffici, persone…).
- **Impostazioni**: comando per collegare Claude e nuova chiave, casella e cartelle, domini
  ammessi, registro del servizio.

In alto si passa tra **In prova** (valuta e registra senza inviare), **Attivo** e **In pausa**.

Da riga di comando restano `mail-router status`, `check`, `token`, `uninstall`,
`setup --terminale` e `install`. Log in `C:\ProgramData\MailRouter\logs`; errori di avvio in
`%TEMP%\mail-router-errori.log`. Per aggiornare: chiudi il pannello, sostituisci l'exe e
lancia da amministratore `mail-router install`.

## Collegare Claude

Il servizio è in rete locale, quindi il collegamento deve partire dal computer dove usi Claude.
I «connettori» dell'app Claude (Personalizza → Connettori) **non vanno bene**: si collegano dai
server di Anthropic su internet, accettano solo indirizzi https pubblici e non vedono la rete
dell'ufficio. Le strade sono due, e il pannello (Impostazioni → Collegare Claude) dà il testo
pronto per entrambe.

- **App Claude (chat)**: in Impostazioni → Sviluppatore → Modifica configurazione aggiungi in
  `claude_desktop_config.json` il server `mail-router`. È lo stesso `mail-router.exe` avviato
  come ponte locale (`bridge`): non serve installare Node.js. Poi chiudi del tutto l'app e
  riaprila. Se l'app è su un altro PC Windows, copia lì l'exe e correggi il percorso.

  ```json
  {
    "mcpServers": {
      "mail-router": {
        "command": "C:\\Program Files\\MailRouter\\mail-router.exe",
        "args": ["bridge", "--url", "http://IP-DEL-PC:8787/mcp"],
        "env": { "MAIL_ROUTER_KEY": "mr_..." }
      }
    }
  }
  ```

- **Claude Code** (terminale o scheda «Code» dell'app): su un computer dove Claude Code è
  installato. Se «claude» non viene trovato, Claude Code su quel PC non c'è; su Windows si
  installa da PowerShell con `irm https://claude.ai/install.ps1 | iex` e poi va aperto un nuovo
  terminale.

  ```bash
  claude mcp add --transport http --scope user mail-router http://IP-DEL-PC:8787/mcp --header "Authorization: Bearer mr_..."
  ```

Esempi di richieste:

- «Com'è messo il servizio? Ci sono errori?»
- «Le mail della Cassa Edile vanno all'ufficio paghe, a meno che l'ufficio paghe sia già in copia.»
- «Prova la regola sulle ultime 200 mail e dimmi dove sbaglia.»
- «Attiva la regola delle fatture» · «Passa in live» · «Metti in pausa tutto.»
- «Cosa hai inoltrato oggi e a chi?» · «Togli la regola dei fornitori» · «Rimetti la versione di ieri.»
- «Cerca le mail non lette di questa settimana da Enel e inoltrale a mario@azienda.it.»

## Strumenti MCP

| Area     | Strumenti |
| -------- | --------- |
| Motore   | `get_status`, `set_mode` (live / shadow / paused), `list_activity`, `list_outbox`, `retry_failed`, `reprocess_email`, `get_logs` |
| Regole   | `get_rule_guide`, `list_rules`, `get_rule`, `create_rule`, `update_rule`, `delete_rule`, `restore_rule`, `test_rules` |
| Dati     | `list_data`, `get_data`, `set_data`, `delete_data` |
| Casella  | `list_folders`, `list_emails`, `search_emails`, `get_email`, `forward_email`, `reply_email`, `send_email`, `move_email`, `set_flags`, `delete_email` |

La guida completa per scrivere regole (oggetto `email`, helper `h`, formato della decisione,
semantica) arriva a Claude come istruzioni del server: è in [src/mcp/guide.ts](src/mcp/guide.ts).
Gli strumenti di lettura non segnano mai i messaggi come letti. Le azioni manuali
(inoltra, rispondi, sposta…) sono immediate e registrate nello storico.

Esempio di regola:

```js
function rule(email, data, h) {
  if (email.bulk || email.autoSubmitted) return null;
  if (h.isFrom(email, data.casseEdili) && !h.sentTo(email, data.uffici.paghe)) {
    return { forward: { to: data.uffici.paghe, note: "Avviso Cassa Edile" }, reason: "Cassa Edile → paghe" };
  }
  return null;
}
```

## Configurazione

`C:\ProgramData\MailRouter\config.json` (creato da `setup`; esempio in
[config.example.json](config.example.json)). Campi principali:

- `accounts[]`: `id`, `imap` e `smtp` (host, porta, utente, `password`), `watch` (cartelle
  sorvegliate), `ownAddresses` (indirizzi della casella: mai destinatari), `sentFolder`,
  `trashFolder`, `markForwarded`. La password può essere `dpapi:…` (da `setup` o
  `mail-router encrypt`), `env:NOME_VARIABILE` o in chiaro (solo per prove).
- `outbound.allowedDomains`: domini raggiungibili dagli inoltri automatici (vuoto = tutti).
  Vale solo per le regole; le azioni manuali da Claude chiedono comunque conferma a te.
- `mcp`: `host`, `port`, `allowedNetworks` (predefinite le reti private), `tls` (`cert`/`key`
  in PEM, facoltativo).
- `engine`: `pollSeconds` (controllo periodico oltre a IDLE), `ruleTimeoutMs`, `maxTextChars`,
  `maxAttempts`, `retentionDays` (storico).

## Sviluppo

Richiede [Bun](https://bun.sh) ≥ 1.3.

```bash
bun install
bun test                       # unit test
bun run typecheck
bun run build:windows          # dist/mail-router.exe (Windows x64, anche CPU senza AVX2)
bun run build:local            # dist/mail-router per questa macchina
```

Prova completa contro un server di posta vero (GreenMail in Docker), con servizio, server MCP e
client MCP nello stesso processo — vedi l'intestazione di [test/e2e.test.ts](test/e2e.test.ts):

```bash
MAIL_ROUTER_E2E=1 bun test test/e2e.test.ts
```

Fuori da Windows `mail-router run --home <cartella>` avvia il servizio in primo piano (con il
supervisore che lo riavvia in caso di crash); `install`, DPAPI e firewall esistono solo su Windows.
