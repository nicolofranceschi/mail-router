import type { Role, User } from "./auth";
import type { AccountRuntime } from "./mail/clients";
import type { App } from "./service/app";

/**
 * What the person behind a key may reach. An administrator sees every
 * mailbox; an operator only the mailboxes assigned to them, with their rules,
 * reference data, mail and activity.
 */
export class Scope {
  private constructor(
    readonly role: Role,
    readonly name: string,
    /** null: every mailbox (administrators). */
    private readonly assigned: ReadonlySet<string> | null,
  ) {}

  static forUser(app: App, user: User): Scope {
    return user.role === "admin" ? Scope.admin(user.name) : new Scope("operator", user.name, new Set(app.store.userAccounts(user.id)));
  }

  static admin(name = "amministratore"): Scope {
    return new Scope("admin", name, null);
  }

  /** For tests and tools: an operator limited to these mailboxes. */
  static operator(accounts: string[], name = "operatore"): Scope {
    return new Scope("operator", name, new Set(accounts));
  }

  get isAdmin(): boolean {
    return this.role === "admin";
  }

  canSee(accountId: string | null): boolean {
    if (this.assigned === null) return true;
    return accountId !== null && this.assigned.has(accountId);
  }

  /** The configured mailboxes this caller may use, in configuration order. */
  accountIds(app: App): string[] {
    return app.config.accounts.map((account) => account.id).filter((id) => this.canSee(id));
  }

  /** For queries: undefined means no filter (administrators). */
  accountFilter(app: App): string[] | undefined {
    return this.assigned === null ? undefined : this.accountIds(app);
  }

  /** The mailbox a tool works on: the one asked for, if allowed, or the caller's first. */
  accountId(app: App, requested?: string): string {
    if (requested) {
      if (!app.config.accounts.some((account) => account.id === requested)) {
        const known = this.accountIds(app).join(", ") || "nessuna";
        throw new Error(`Casella sconosciuta: ${requested} (le tue caselle: ${known})`);
      }
      if (!this.canSee(requested)) throw new Error(`Non hai accesso alla casella ${requested}`);
      return requested;
    }
    const first = this.accountIds(app)[0];
    if (!first) throw new Error("Non hai caselle di posta assegnate: chiedi a un amministratore di assegnartene una");
    return first;
  }

  account(app: App, requested?: string): AccountRuntime {
    return app.account(this.accountId(app, requested));
  }

  /** Throws unless the caller may work on this rule's mailbox (rules without a mailbox: administrators only). */
  requireRuleAccess(app: App, ruleId: string): void {
    const account = app.store.ruleAccount(ruleId);
    if (account === undefined) throw new Error(`Regola ${ruleId} non trovata`);
    // An operator is not told whether a rule of someone else's mailbox exists.
    if (!this.canSee(account)) throw new Error(`Regola ${ruleId} non trovata`);
  }
}
