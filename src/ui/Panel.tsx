import { useEffect, useState } from "react";

import { api, tool } from "./api";
import { Confirm, useAction, useLoad } from "./components";
import { ENGINE_MODE } from "./format";
import { BrandMark, LogoutIcon, NAV_ICONS } from "./icons";
import { Activity } from "./pages/Activity";
import { DataPage } from "./pages/Data";
import { Mailbox } from "./pages/Mailbox";
import { Overview } from "./pages/Overview";
import { Accounts } from "./pages/Accounts";
import { Rules } from "./pages/Rules";
import { Settings } from "./pages/Settings";
import { Users } from "./pages/Users";

export interface CurrentUser {
  id: string;
  name: string;
  role: "admin" | "operator";
}

const PAGES = [
  { id: "panoramica", label: "Panoramica" },
  { id: "regole", label: "Regole" },
  { id: "attivita", label: "Attività" },
  { id: "posta", label: "Posta" },
  { id: "dati", label: "Dati di riferimento" },
  { id: "caselle", label: "Caselle di posta", admin: true },
  { id: "utenti", label: "Utenti", admin: true },
  { id: "impostazioni", label: "Impostazioni" },
] as const;

type PageId = (typeof PAGES)[number]["id"];

function pagesFor(user: CurrentUser) {
  return PAGES.filter((page) => !("admin" in page) || user.role === "admin");
}

function currentPage(user: CurrentUser): PageId {
  const id = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return (pagesFor(user).find((page) => page.id === id)?.id ?? "panoramica") as PageId;
}

export function Panel({ instanceName, version, user, onLogout }: { instanceName: string; version: string; user: CurrentUser; onLogout: () => void }) {
  const [page, setPage] = useState<PageId>(() => currentPage(user));
  useEffect(() => {
    const onHash = () => setPage(currentPage(user));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [user]);
  const isAdmin = user.role === "admin";

  const status = useLoad(() => tool("get_status"), [], 20_000);
  const mode: string = status.data?.mode ?? "shadow";

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <BrandMark />
          <span className="ellipsis">Mail Router</span>
        </div>
        <div className="nav-items">
          {pagesFor(user).map((entry) => (
            <a
              key={entry.id}
              href={`#/${entry.id}`}
              className={`nav-item ${page === entry.id ? "active" : ""}`}
              aria-current={page === entry.id ? "page" : undefined}
            >
              {NAV_ICONS[entry.id]}
              <span>{entry.label}</span>
            </a>
          ))}
        </div>
        <div className="sidebar-foot">
          <span className="sidebar-user ellipsis" title={`${user.name} (${isAdmin ? "amministratore" : "operatore"})`}>
            {user.name} · {isAdmin ? "amministratore" : "operatore"}
          </span>
          <span>Versione {version}</span>
          <a
            href="#"
            className="logout"
            onClick={async (event) => {
              event.preventDefault();
              await api("/api/session/logout", {}).catch(() => undefined);
              onLogout();
            }}
          >
            <LogoutIcon />
            Esci
          </a>
        </div>
      </nav>
      <div className="main">
        <header className="topbar">
          <span className="topbar-title ellipsis">{instanceName}</span>
          <ModeSwitch mode={mode} onChanged={status.reload} />
        </header>
        <main className="content">
          {page === "panoramica" ? <Overview status={status} /> : null}
          {page === "regole" ? <Rules /> : null}
          {page === "attivita" ? <Activity /> : null}
          {page === "posta" ? <Mailbox status={status.data} /> : null}
          {page === "dati" ? <DataPage /> : null}
          {page === "caselle" && isAdmin ? <Accounts onChanged={status.reload} /> : null}
          {page === "utenti" && isAdmin ? <Users me={user.id} /> : null}
          {page === "impostazioni" ? <Settings isAdmin={isAdmin} /> : null}
        </main>
      </div>
    </div>
  );
}

function ModeSwitch({ mode, onChanged }: { mode: string; onChanged: () => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const { run } = useAction();
  const apply = (next: string, skipBacklog = false) =>
    run(async () => {
      await tool("set_mode", { mode: next, skipBacklog });
      onChanged();
    }, `Modalità: ${ENGINE_MODE[next]?.label}`);

  return (
    <>
      <div className="segmented" role="radiogroup" aria-label="Modalità">
        {(["shadow", "live", "paused"] as const).map((value) => (
          <button
            key={value}
            role="radio"
            aria-checked={mode === value}
            title={ENGINE_MODE[value]?.help}
            className={`${mode === value ? "on" : ""} ${value === "live" ? "live" : value === "paused" ? "paused" : ""}`}
            onClick={() => (value === mode ? undefined : setPending(value))}
          >
            {ENGINE_MODE[value]?.label}
          </button>
        ))}
      </div>
      {pending === "live" ? (
        <Confirm
          title="Attivare Mail Router?"
          confirmLabel="Attiva"
          onClose={() => setPending(null)}
          onConfirm={() => apply("live")}
        >
          Da questo momento le regole <b>attive</b> inoltreranno, etichetteranno e sposteranno davvero i nuovi messaggi. Le
          regole «in prova» continueranno solo a registrare cosa farebbero.
        </Confirm>
      ) : null}
      {pending === "shadow" ? (
        <Confirm title="Tornare in prova?" confirmLabel="Metti in prova" onClose={() => setPending(null)} onConfirm={() => apply("shadow")}>
          Le regole continueranno a essere valutate, ma non verrà inviato né spostato nulla. Le azioni ancora in coda vengono
          annullate.
        </Confirm>
      ) : null}
      {pending === "paused" ? (
        <Confirm title="Mettere in pausa?" confirmLabel="Metti in pausa" onClose={() => setPending(null)} onConfirm={() => apply("paused")}>
          I nuovi messaggi non verranno valutati finché non riprendi; alla ripresa verranno elaborati quelli arrivati nel
          frattempo.
        </Confirm>
      ) : null}
    </>
  );
}
