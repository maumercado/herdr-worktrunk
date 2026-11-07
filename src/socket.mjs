// Herdr socket client, used for the one thing the CLI cannot do: keep an
// events.subscribe connection open. Newline-delimited JSON, one request per line.
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** Same lookup order Herdr documents: HERDR_SOCKET_PATH, HERDR_SESSION, default. */
export function socketPath(env = process.env) {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const base = join(homedir(), ".config", "herdr");
  if (env.HERDR_SESSION) return join(base, "sessions", env.HERDR_SESSION, "herdr.sock");
  return join(base, "herdr.sock");
}

/**
 * Subscribe to Herdr events. Resolves once Herdr acknowledges the subscription,
 * rejects if the socket is missing or the request fails.
 *
 *   onEvent(message)  every pushed line after the acknowledgement
 *   onClose()         the connection ended (server stopped or restarted)
 */
export function subscribe(types, { path = socketPath(), onEvent = () => {}, onClose = () => {}, timeout = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    let acked = false;
    let buf = "";
    const timer = setTimeout(() => fail(new Error("events.subscribe timed out")), timeout);

    function fail(error) {
      clearTimeout(timer);
      if (!acked) reject(error);
      sock.destroy();
    }

    sock.setEncoding("utf8");
    sock.on("connect", () => {
      const params = { subscriptions: types.map((type) => ({ type })) };
      sock.write(`${JSON.stringify({ id: "wt_sub", method: "events.subscribe", params })}\n`);
    });
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!acked && msg.id === "wt_sub") {
          if (msg.error) return fail(new Error(`events.subscribe: ${msg.error.code}: ${msg.error.message}`));
          acked = true;
          clearTimeout(timer);
          resolve({ close: () => sock.end() });
          continue;
        }
        if (acked) onEvent(msg);
      }
    });
    sock.on("error", (error) => fail(error));
    sock.on("close", () => {
      clearTimeout(timer);
      if (!acked) reject(new Error("socket closed before subscribe was acknowledged"));
      else onClose();
    });
  });
}

/** Best effort event name from a pushed message, whatever envelope Herdr uses. */
export function eventType(msg) {
  return msg?.event?.type ?? msg?.type ?? msg?.event ?? msg?.result?.type ?? msg?.params?.type ?? msg?.method ?? null;
}
