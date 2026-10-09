import { useState } from "react";

import { CopyButton } from "./components";

export interface Access {
  command: string;
  desktopConfig: string;
  mcpUrl: string;
  panelUrl: string;
}

/**
 * The two ways to reach the service from a PC on the LAN. The Claude app's
 * "connectors" are not one of them: they connect from Anthropic's cloud and
 * accept only public https addresses.
 */
export function ClaudeAccess({ access, keyKnown }: { access: Access; keyKnown: boolean }) {
  const [tab, setTab] = useState<"app" | "code">("app");
  return (
    <div className="stack">
      <div className="segmented" role="tablist">
        <button className={tab === "app" ? "on" : ""} onClick={() => setTab("app")} role="tab" aria-selected={tab === "app"}>
          App Claude (chat)
        </button>
        <button className={tab === "code" ? "on" : ""} onClick={() => setTab("code")} role="tab" aria-selected={tab === "code"}>
          Claude Code
        </button>
      </div>

      {tab === "app" ? (
        <div className="stack tight">
          <ol className="small" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
            <li>
              Nell'app Claude apri <b>Impostazioni → Sviluppatore → Modifica configurazione</b> (il file{" "}
              <span className="mono">claude_desktop_config.json</span>).
            </li>
            <li>
              Incolla questo testo{keyKnown ? "" : ", mettendo la chiave di accesso al posto di <CHIAVE>"}. Se il file contiene già
              altri server, aggiungi solo la voce «mail-router» dentro «mcpServers».
            </li>
            <li>Salva e chiudi del tutto l'app Claude (anche dall'icona vicino all'orologio), poi riaprila.</li>
          </ol>
          <pre className="block code">{access.desktopConfig}</pre>
          <div className="row wrap">
            <CopyButton text={access.desktopConfig} label="Copia la configurazione" />
            <span className="muted small">
              Se l'app Claude è su un altro computer Windows, copia lì anche mail-router.exe e correggi il percorso in «command».
            </span>
          </div>
        </div>
      ) : (
        <div className="stack tight">
          <p className="small">
            In un terminale del computer dove usi Claude Code (o nella scheda «Code» dell'app Claude){keyKnown ? "" : ", sostituendo <CHIAVE>"}:
          </p>
          <pre className="block">{access.command}</pre>
          <div className="row wrap">
            <CopyButton text={access.command} label="Copia il comando" />
            <span className="muted small">«claude» non trovato? Claude Code non è installato su quel computer.</span>
          </div>
        </div>
      )}

      <p className="muted small">
        I «connettori» dell'app Claude non funzionano qui: si collegano dai server di Anthropic su internet e non vedono la rete
        dell'ufficio. Pannello da altri computer: <span className="mono">{access.panelUrl}</span>
      </p>
    </div>
  );
}
