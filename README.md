# Mail Router

Servizio in un container Docker che sorveglia caselle IMAP e **inoltra in automatico** la
posta secondo regole scritte in codice da Claude. Ha un **pannello di controllo** (browser dalla
rete) e un **server MCP**: dal tuo PC colleghi Claude e, parlando in italiano, aggiungi,
modifichi o togli regole e gestisci la casella (leggi, cerchi, inoltri, rispondi, sposti, segni,
elimini).

```
 Server di posta (IMAP/SMTP)
          ▲  IDLE + polling, lettura senza segnare come letto
          │
 ┌────────┴──────── container mail-router (Docker) ────────────┐
 │   monitor IMAP → regole JS in sandbox QuickJS → decisione  │
 │   coda azioni (inoltro, flag, letto, sposta) con retry     │
 │   SQLite nel volume /data: regole, dati, storico, coda     │
 │   pannello :8787/ + server MCP :8787/mcp (chiave, rete loc.)│
 └────────▲────────────────────────────────────────────────────┘
          │  LAN / VPN
     Claude sul tuo PC
```

## Come funziona

- **Solo i messaggi nuovi.** Al primo avvio il servizio memorizza l'ultimo UID della cartella e
  da lì in avanti valuta ogni messaggio in arrivo, una volta sola (anche dopo riavvii).
- **Regole = codice.** Ogni regola è una funzione JavaScript `rule(email, data, h)` che restituisce
  `null` oppure una decisione (`forward`, `flags`, `markRead`, `moveTo`, `stop`, `reason`). Gira in
  una sandbox QuickJS/WebAssembly senza rete, file o processi, con limiti di tempo e memoria:
  una regola sbagliata non può fare danni né fermare le altre.
- **La posta smistata resta da leggere.** Un messaggio inoltrato o spostato da una regola non viene
  segnato come letto, salvo che l'account lo chieda (impostazione «Segna come letta la posta
  smistata» nel pannello, o lo strumento MCP `set_account_options`); una regola può sempre decidere
  con `markRead: true/false`. Se l'inoltro o lo spostamento non riesce, resta dov'è e non letto,
  così chi lavora la cartella lo vede.
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

## Installazione con Docker

Serve una macchina sempre accesa con Docker che raggiunga il server di posta (anche l'SMTP, se
l'invio è consentito solo dalla rete d'ufficio).

1. Copia il progetto sulla macchina, accanto a `compose.yaml` crea `.env` partendo da
   [.env.example](.env.example) e genera la **chiave master**:

   ```bash
   docker compose build
   docker compose run --rm mail-router genkey
   ```

   Metti il valore in `MAIL_ROUTER_MASTER_KEY` e **conservane una copia fuori dalla macchina**
   (gestore di password): cifra le password delle caselle salvate in `config.json`. Senza la
   chiave le password vanno reinserite; regole e storico non si perdono.
2. `docker compose up -d`. Senza configurazione il container apre la **procedura guidata**:
   l'indirizzo con il codice di accesso è nel log (`docker compose logs mail-router`). La
   procedura chiede casella, cartelle, invio e domini ammessi.
3. Alla fine compare **una sola volta** la chiave di accesso, con il comando per collegare
   Claude: copiali. Il servizio parte subito nel container, in modalità «in prova».

Dati, configurazione e log stanno nel volume `mail-router-data` (`/data`). Il container si
riavvia da solo (`restart: unless-stopped`) e ha un healthcheck su `/health`. Il filtro per rete
(`mcp.allowedNetworks`) vede l'indirizzo che arriva al container: pubblicando la porta su
internet, metti davanti un reverse proxy https.

### Docker nella WSL di un PC Windows (installazione attuale, PC70Z)

Docker Desktop non va bene per un servizio sempre acceso: parte solo con un utente collegato e,
da una sessione remota, non scarica le immagini. Su PC70Z il container gira con **Docker Engine
dentro la WSL Ubuntu** (`/opt/mail-router`):

- `%USERPROFILE%\.wslconfig` con `networkingMode=mirrored` e `vmIdleTimeout=-1`: il container
  risponde all'indirizzo del PC (`pc70z.zini.locale:8787`);
- regole firewall «Mail Router (Docker WSL)» (Windows e Hyper-V) sulla porta 8787 dalle reti
  private;
- attività pianificata `MailRouter-WSL`: **al login di `zini\mazzisil`** avvia la WSL in modo
  nascosto; systemd avvia Docker, Docker il container. Dopo un riavvio del PC lo smistamento
  riparte quando quell'utente accede. Per l'avvio senza login serve il diritto «Accesso come
  processo batch» per l'utente dell'attività (oggi la policy di dominio lo dà solo a
  `ZINI\ASPNET_USER`).

Comandi utili, da PowerShell sul PC:

```powershell
wsl -d Ubuntu -u root -- docker compose -f /opt/mail-router/compose.yaml ps
wsl -d Ubuntu -u root -- docker compose -f /opt/mail-router/compose.yaml logs --tail 100 mail-router
wsl -d Ubuntu -u root -- docker exec mail-router mail-router token
```

### Passare da una vecchia installazione Windows

Sul PC con il vecchio servizio, da amministratore, con l'exe nuovo:

1. ferma il vecchio servizio con il suo exe: `"C:\Program Files\MailRouter\mail-router.exe" uninstall`
   (i dati restano) e fai una copia di `C:\ProgramData\MailRouter`;
2. `mail-router.exe export-docker --out .\export --key <chiave master>`: decifra le password
   DPAPI, le ricifra con la chiave del container e copia il database in modo consistente;
3. sulla macchina Docker: `docker compose run --rm -v ./export:/import:ro mail-router import /import`
   (verifica che la chiave apra ogni password) e `docker compose up -d`.

Regole, dati, storico, coda e punto di lettura delle cartelle passano identici; la chiave di
accesso esistente resta valida.

## Il pannello

Da qualsiasi computer della rete all'indirizzo `http://IP-DEL-SERVER:8787/` (a Zini:
`http://pc70z.zini.locale:8787/`), inserendo la propria chiave di accesso. Le sezioni:

- **Panoramica**: modalità, cartelle collegate, coda di invio, ultimi messaggi.
- **Regole**: codice, priorità, accensione (attiva / in prova / spenta), prova sulle ultime
  mail vere, cronologia con ripristino. Ogni regola appartiene a una casella e vale solo per la
  sua posta; con più caselle si sceglie in alto quale guardare.
- **Attività**: per ogni messaggio le regole applicate e le azioni (fatto, in coda, errore,
  simulato, bloccato), con «Riprova» per quelle non riuscite.
- **Posta**: elenco e ricerca (con più caselle, si sceglie la casella), lettura senza segnare
  come letto, inoltra, sposta, elimina e «Prova le regole» su un messaggio.
- **Dati di riferimento**: gli elenchi che le regole leggono (uffici, persone…), anche questi
  separati per casella.
- **Caselle di posta** (amministratori): aggiungi, modifica ed elimina le caselle sorvegliate,
  ognuna con i suoi server IMAP/SMTP, cartelle e opzioni di inoltro. Ogni salvataggio verifica
  l'accesso e riavvia il servizio per qualche secondo; una casella nuova parte dai messaggi che
  arrivano da quel momento. Ogni casella ha le sue regole e i suoi dati di riferimento.
- **Utenti** (amministratori): ogni persona ha la sua chiave di accesso, valida per il pannello e
  per Claude, mostrata una sola volta alla creazione. Si può rigenerare o revocare (eliminando
  l'utente) senza toccare le chiavi degli altri. Ruoli: **amministratore** (tutte le caselle e
  tutto il resto) e **operatore**: vede e gestisce solo le caselle che gli vengono assegnate
  (di solito una, a volte più), con la loro posta, le loro regole, i loro dati e la loro attività;
  niente caselle, impostazioni, utenti, modalità del servizio, registro né `set_account_options`.
  Un operatore senza caselle assegnate non vede nulla. Deve restare almeno un amministratore.

Aggiornando da una versione in cui regole e dati erano comuni: con una sola casella passano
tutti a quella casella; con più caselle restano «senza casella», continuano a valere per tutte e
l'amministratore li assegna dalla pagina Regole (e Dati di riferimento).
- **Impostazioni**: comando per collegare Claude con la propria chiave e nuova chiave personale;
  per gli amministratori nome dell'installazione e domini ammessi; registro del servizio. La
  porta si sceglie in `compose.yaml` (`MAIL_ROUTER_PUBLISH`): nel container è sempre 8787.

Aggiornando da una versione con chiave unica, quella chiave diventa l'utente «Amministratore»
(le sessioni del pannello aperte vanno rifatte). `mail-router token` rigenera la chiave
dell'amministratore principale.

In alto si passa tra **In prova** (valuta e registra senza inviare), **Attivo** e **In pausa**.

Nel container (`docker exec mail-router mail-router <comando>`) ci sono `status`, `check`,
`token`, `encrypt` (cifra una password letta da stdin) e `genkey`. Log su stdout
(`docker compose logs`) e in `/data/logs`. Per aggiornare: `docker compose build` e
`docker compose up -d`.

## Collegare Claude

Il servizio è in rete locale, quindi il collegamento deve partire dal computer dove usi Claude.
I «connettori» dell'app Claude (Personalizza → Connettori) **non vanno bene**: si collegano dai
server di Anthropic su internet, accettano solo indirizzi https pubblici e non vedono la rete
dell'ufficio. Le strade sono due, e il pannello (Impostazioni → Collegare Claude) dà il testo
pronto per entrambe.

- **App Claude (chat)**: in Impostazioni → Sviluppatore → Modifica configurazione aggiungi in
  `claude_desktop_config.json` il server `mail-router`. È `mail-router.exe` (versione Windows,
  `bun run build:windows`) avviato come ponte locale (`bridge`): non serve installare Node.js.
  Copialo in `C:\MailRouter` sul PC dove usi l'app (o correggi il percorso), poi chiudi del
  tutto l'app e riaprila.

  ```json
  {
    "mcpServers": {
      "mail-router": {
        "command": "C:\\MailRouter\\mail-router.exe",
        "args": ["bridge", "--url", "http://IP-DEL-SERVER:8787/mcp"],
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
  claude mcp add --transport http --scope user mail-router http://IP-DEL-SERVER:8787/mcp --header "Authorization: Bearer mr_..."
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
| Motore   | `get_status`, `set_mode` (live / shadow / paused), `set_account_options` (posta smistata letta o da leggere), `list_activity`, `list_outbox`, `retry_failed`, `reprocess_email`, `get_logs` |
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

`/data/config.json` nel volume (creato dalla procedura guidata o da `import`; esempio in
[config.example.json](config.example.json)). Campi principali:

- `accounts[]`: `id`, `imap` e `smtp` (host, porta, utente, `password`), `watch` (cartelle
  sorvegliate), `ownAddresses` (indirizzi della casella: mai destinatari), `sentFolder`,
  `trashFolder`, `markForwarded`. La password è `aes:…` (cifrata con la chiave master, dal
  pannello o con `mail-router encrypt`), `env:NOME_VARIABILE` o `plain:…` (solo per prove,
  con `MAIL_ROUTER_ALLOW_PLAIN=1`).
- `outbound.allowedDomains`: domini raggiungibili dagli inoltri automatici (vuoto = tutti).
  Vale solo per le regole; le azioni manuali da Claude chiedono comunque conferma a te.
- `mcp`: `host`, `port`, `allowedNetworks` (predefinite le reti private), `tls` (`cert`/`key`
  in PEM, facoltativo).
- `engine`: `pollSeconds` (controllo periodico oltre a IDLE), `ruleTimeoutMs`, `maxTextChars`,
  `maxAttempts`, `retentionDays` (storico).

## Sviluppo

Richiede [Bun](https://bun.sh) ≥ 1.3 (oppure solo Docker: `docker compose build` esegue
typecheck e test).

```bash
bun install
bun test                       # unit test
bun run typecheck
bun run build:windows          # dist/mail-router.exe: ponte per l'app Claude ed export-docker
bun run build:local            # dist/mail-router per questa macchina
```

Variabili d'ambiente del container: `MAIL_ROUTER_MASTER_KEY` (o `MAIL_ROUTER_MASTER_KEY_FILE`
per un Docker secret), `MAIL_ROUTER_PUBLIC_URL` (indirizzo mostrato nelle istruzioni di
collegamento), `MAIL_ROUTER_SETUP_CODE` (codice fisso per la procedura guidata, facoltativo).

Prova completa contro un server di posta vero (GreenMail in Docker), con servizio, server MCP e
client MCP nello stesso processo — vedi l'intestazione di [test/e2e.test.ts](test/e2e.test.ts):

```bash
MAIL_ROUTER_E2E=1 bun test test/e2e.test.ts
```

Fuori da Windows `mail-router run --home <cartella>` avvia il servizio in primo piano (con il
supervisore che lo riavvia in caso di crash); `install`, DPAPI e firewall esistono solo su Windows.
