/**
 * Executable entry point. It installs the crash reporters before anything
 * else is loaded, so even an error raised while the modules initialise ends
 * up on screen and in the error file instead of a window that just closes.
 */
import { reportCrash, reportFailure } from "./crash";

process.on("uncaughtException", (error) => {
  reportCrash("errore non gestito", error);
  // The background service registers its own handler that logs and exits first.
  setTimeout(() => process.exit(1), 50);
});
process.on("unhandledRejection", (error) => reportCrash("promessa rifiutata", error));

try {
  await import("./main");
} catch (error) {
  reportFailure("avvio", error);
  process.exit(1);
}
