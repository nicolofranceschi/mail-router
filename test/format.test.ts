import { describe, expect, test } from "bun:test";

import { folderPrefix, folderTail, friendlyError, lastSegment, overallState, watcherHealth } from "../src/ui/format";

const BASE = "Cartelle pubbliche/zinielio.it/info";
const refused = "connect ECONNREFUSED 192.168.120.24:993";

describe("stato delle cartelle", () => {
  test("un errore già superato non è un problema, resta solo come interruzione passata", () => {
    const watchers = [
      { folder: BASE, connected: true, lastError: refused, lastErrorAt: "2026-11-01T06:12:49.289Z" },
      { folder: `${BASE}/MULTE`, connected: true, lastError: refused, lastErrorAt: "2026-11-01T06:12:49.692Z" },
    ];
    const health = watcherHealth(watchers);
    expect(health.down).toEqual([]);
    expect(health.connected).toBe(2);
    expect(health.lastInterruption).toEqual({ at: "2026-11-01T06:12:49.692Z", error: refused });

    const state = overallState("live", watchers, 0);
    expect(state.tone).toBe("ok");
    expect(state.title).toBe("Tutto regolare");
    expect(state.detail).toContain("2 cartelle collegate.");
  });

  test("una cartella non collegata adesso è un errore, con la causa in italiano", () => {
    const watchers = [
      { folder: BASE, connected: false, lastError: refused, lastErrorAt: "2026-11-05T08:00:00.000Z" },
      { folder: `${BASE}/MULTE`, connected: true },
    ];
    const state = overallState("live", watchers, 3);
    expect(state.tone).toBe("err");
    expect(state.title).toBe("1 cartella non collegata");
    expect(state.detail).toBe("Il server di posta ha rifiutato la connessione. Mail Router ritenta il collegamento da solo.");
    expect(watcherHealth(watchers).lastInterruption).toBeNull();
  });

  test("appena avviato, senza errori registrati, non inventa una causa", () => {
    const state = overallState("live", [{ folder: BASE, connected: false }], 0);
    expect(state.detail).toBe("Mail Router ritenta il collegamento da solo.");
  });

  test("azioni fallite e modalità cambiano il messaggio solo se le cartelle sono collegate", () => {
    const watchers = [{ folder: BASE, connected: true }];
    expect(overallState("live", watchers, 2)).toMatchObject({ tone: "warn", title: "2 azioni non riuscite" });
    expect(overallState("shadow", watchers, 0)).toMatchObject({ tone: "info", title: "In prova" });
    expect(overallState("paused", watchers, 0)).toMatchObject({ tone: "warn", title: "In pausa" });
    expect(overallState("live", watchers, 0).detail).toContain("1 cartella collegata.");
  });
});

describe("friendlyError", () => {
  test("traduce gli errori di connessione noti", () => {
    expect(friendlyError(refused)).toBe("il server di posta ha rifiutato la connessione");
    expect(friendlyError("Socket timeout")).toBe("il server di posta non ha risposto in tempo");
    expect(friendlyError("unable to verify the first certificate")).toBe("il certificato del server di posta non è valido");
  });

  test("lascia intatto il testo che non conosce", () => {
    expect(friendlyError("Mailbox doesn't exist")).toBe("Mailbox doesn't exist");
  });
});

describe("percorsi delle cartelle", () => {
  test("il prefisso comune si ferma ai confini delle cartelle", () => {
    expect(folderPrefix([BASE, `${BASE}/MULTE`, `${BASE}/Contabili/C.E.D.A`])).toBe(BASE);
    expect(folderPrefix(["INBOX/Fatture", "INBOX/Fatture 2"])).toBe("INBOX");
    expect(folderPrefix(["INBOX", "Posta inviata"])).toBe("");
    expect(folderPrefix([BASE])).toBe("");
  });

  test("ogni riga mostra solo la parte che cambia", () => {
    expect(folderTail(`${BASE}/Contabili/C.E.D.A`, BASE)).toBe("Contabili/C.E.D.A");
    expect(folderTail(BASE, BASE)).toBe("info");
    expect(folderTail("INBOX", "")).toBe("INBOX");
    expect(lastSegment(`${BASE}/CAMBIO IBAN`)).toBe("CAMBIO IBAN");
  });
});
