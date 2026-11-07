import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { verifyLiveStateProcess, type LiveStateProcessIdentity } from "./live-state-process.ts";
import type { LiveStateInspector } from "./live-state-controller.ts";

const MAX_MESSAGE_BYTES = 180 * 1024 * 1024;
const MAX_PENDING = 16;
const SOCKET_TIMEOUT_MS = 5000;

function verifyListener(target: LiveStateProcessIdentity, port: number): void {
  verifyLiveStateProcess(target);
  const root = `/proc/${target.pid}`;
  const address = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  const entries = readFileSync(`${root}/net/tcp`, "utf8").split("\n").slice(1).map(line => line.trim().split(/\s+/)).filter(fields => fields[1] === address && fields[3] === "0A");
  if (entries.length !== 1 || !entries[0]?.[9] || !/^\d+$/.test(entries[0][9])) throw new Error("inspector listener is unavailable or ambiguous");
  const inode = `socket:[${entries[0][9]}]`;
  let found = false;
  for (const fd of readdirSync(`${root}/fd`)) {
    try { if (readlinkSync(`${root}/fd/${fd}`) === inode) found = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!found) throw new Error("inspector listener is not owned by target process");
  verifyLiveStateProcess(target);
}

// Socket ownership does not isolate the endpoint from other local processes.
export async function connectLiveStateInspector(target: LiveStateProcessIdentity, endpoint: string, sourceUrl: string): Promise<LiveStateInspector> {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("invalid inspector endpoint"); }
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash || !/^\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(url.pathname) || !sourceUrl.startsWith("file://")) throw new Error("invalid inspector endpoint");
  const port = Number(url.port);
  verifyListener(target, port);
  const socket = new WebSocket(url.href);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const scripts: Array<{ scriptId: string; url: string }> = [];
  let nextId = 0;
  let closed = false;
  let pause: unknown;
  let pauseWaiter: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
  function fail(): void {
    closed = true;
    for (const request of pending.values()) request.reject(new Error("inspector connection closed"));
    pending.clear();
    pauseWaiter?.reject(new Error("inspector connection closed"));
    pauseWaiter = undefined;
  }
  socket.addEventListener("close", fail);
  socket.addEventListener("error", fail);
  socket.addEventListener("message", event => {
    try {
      if (typeof event.data !== "string" || Buffer.byteLength(event.data, "utf8") > MAX_MESSAGE_BYTES) throw new Error("invalid message");
      const message = JSON.parse(event.data) as { id?: number; method?: string; params?: { scriptId?: string; url?: string }; error?: unknown; result?: unknown };
      if (message.method === "Debugger.scriptParsed" && message.params?.url === sourceUrl && typeof message.params.scriptId === "string") {
        if (scripts.length >= 2) throw new Error("ambiguous source");
        scripts.push({ scriptId: message.params.scriptId, url: sourceUrl });
      }
      if (message.method === "Debugger.paused") {
        if (pause !== undefined) throw new Error("unexpected repeated pause");
        pause = message.params;
        if (pauseWaiter) { pauseWaiter.resolve(pause); pauseWaiter = undefined; }
      }
      if (typeof message.id === "number") {
        const request = pending.get(message.id);
        if (request) { pending.delete(message.id); if (message.error) request.reject(new Error("inspector command failed")); else request.resolve(message.result); }
      }
    } catch { fail(); socket.close(); }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("inspector connection timed out")); }, SOCKET_TIMEOUT_MS);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("inspector connection failed")); }, { once: true });
    });
    verifyListener(target, port);
  } catch (error) { socket.close(); throw error; }
  return {
    scripts: () => scripts.slice(),
    waitForPause: () => {
      if (closed) return Promise.reject(new Error("inspector connection closed"));
      if (pause !== undefined) return Promise.resolve(pause as never);
      if (pauseWaiter) return Promise.reject(new Error("inspector pause already awaited"));
      return new Promise((resolve, reject) => { pauseWaiter = { resolve: value => resolve(value as never), reject }; });
    },
    send: (method, params = {}) => {
      if (closed || socket.readyState !== WebSocket.OPEN || pending.size >= MAX_PENDING) return Promise.reject(new Error("inspector connection unavailable"));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        try { socket.send(JSON.stringify({ id, method, params })); } catch { pending.delete(id); reject(new Error("inspector request failed")); }
      });
    },
    close: async () => {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("inspector disconnect timed out")), SOCKET_TIMEOUT_MS);
        socket.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.close();
      });
    },
  };
}
