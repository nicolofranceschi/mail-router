/**
 * Where the service can be reached and how Claude connects to it. Inside a
 * container the network interfaces say nothing useful (172.x of the Docker
 * bridge), so the address comes from MAIL_ROUTER_PUBLIC_URL or, in the panel,
 * from the address the browser itself used.
 */

export const PUBLIC_URL_ENV = "MAIL_ROUTER_PUBLIC_URL";

/** Where the Windows bridge is assumed to be copied on the PC running the Claude app. */
export const BRIDGE_EXE = "C:\\MailRouter\\mail-router.exe";

/** The service's base address without the trailing slash: configured, seen by the browser, or a placeholder. */
export function publicBase(mcp: { port: number; tls?: unknown }, requestOrigin?: string): string {
  const configured = process.env[PUBLIC_URL_ENV]?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (requestOrigin) return requestOrigin.replace(/\/+$/, "");
  return `${mcp.tls ? "https" : "http"}://<IP-DEL-SERVER>:${mcp.port}`;
}

export function accessInfo(mcp: { port: number; tls?: unknown }, token = "<CHIAVE>", requestOrigin?: string) {
  const base = publicBase(mcp, requestOrigin);
  const mcpUrl = `${base}/mcp`;
  // The Claude app reaches "connectors" from Anthropic's cloud, which cannot see the LAN:
  // a server in its config file runs on the user's PC, so it starts the Windows exe as a local bridge.
  const desktopConfig = JSON.stringify(
    { mcpServers: { "mail-router": { command: BRIDGE_EXE, args: ["bridge", "--url", mcpUrl], env: { MAIL_ROUTER_KEY: token } } } },
    null,
    2,
  );
  return {
    panelUrl: `${base}/`,
    mcpUrl,
    command: `claude mcp add --transport http --scope user mail-router ${mcpUrl} --header "Authorization: Bearer ${token}"`,
    desktopConfig,
  };
}

export function connectInstructions(token: string, mcp: { port: number; tls?: unknown }): string {
  const { command, panelUrl } = accessInfo(mcp, token);
  return [
    "Chiave di accesso (viene mostrata solo ora: conservala in un posto sicuro):",
    `  ${token}`,
    "",
    "Dal tuo PC, collega Claude Code a questo servizio con:",
    `  ${command}`,
    "",
    `Pannello: ${panelUrl}`,
    ...(process.env[PUBLIC_URL_ENV] ? [] : ["(imposta MAIL_ROUTER_PUBLIC_URL per avere qui l'indirizzo vero del server)"]),
  ].join("\n");
}
