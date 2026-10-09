import { findAccount, type Config } from "./config";
import { errorMessage } from "./log";
import { verifySmtp, withImap, type AccountRuntime } from "./mail/clients";
import { resolveSecret } from "./secrets";

export async function listFoldersFor(account: AccountRuntime) {
  return withImap(account, "verifica", async (client) => {
    const folders = await client.list();
    return folders.map((folder) => ({ path: folder.path, specialUse: folder.specialUse ?? null }));
  });
}

export function accountRuntime(config: Config, accountId: string): AccountRuntime {
  const account = findAccount(config, accountId);
  return {
    config: account,
    imapPassword: resolveSecret(account.imap.password, `${account.id}.imap.password`),
    smtpPassword: account.smtp ? resolveSecret(account.smtp.password, `${account.id}.smtp.password`) : null,
  };
}

/** Logs in, checks every configured folder exists and verifies SMTP. Returns the problems found. */
export async function verifyAccount(config: Config, accountId: string): Promise<string[]> {
  const problems: string[] = [];
  let account: AccountRuntime;
  try {
    account = accountRuntime(config, accountId);
  } catch (error) {
    return [errorMessage(error)];
  }
  try {
    const folders = new Set((await listFoldersFor(account)).map((folder) => folder.path));
    const wanted = [
      ...account.config.watch.map((folder) => ["monitorata", folder] as const),
      ...(account.config.sentFolder ? [["inviati", account.config.sentFolder] as const] : []),
      ...(account.config.trashFolder ? [["cestino", account.config.trashFolder] as const] : []),
    ];
    for (const [role, folder] of wanted) {
      if (!folders.has(folder)) problems.push(`cartella ${role} "${folder}" non trovata sul server`);
    }
  } catch (error) {
    problems.push(`IMAP: ${errorMessage(error)}`);
  }
  if (account.config.smtp) {
    try {
      await verifySmtp(account);
    } catch (error) {
      problems.push(`SMTP: ${errorMessage(error)}`);
    }
  }
  return problems;
}
