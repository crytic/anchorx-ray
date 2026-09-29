import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Session, SessionEvent } from "@anchorx-ray/core";

export interface ServerStatus {
  rpcUrl: string;
  cluster: string;
  root: string;
  /** Name of the snapshot being inspected offline, if any. */
  snapshot?: string;
  warnings: string[];
}

export interface ServerOptions {
  session: Session;
  status: ServerStatus;
  /** Directory with the built web UI. */
  webDir: string;
  port: number;
}

type Handler = (req: http.IncomingMessage, url: URL) => unknown;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Rejects requests whose Host is not this loopback server (DNS rebinding) and
 * state-changing requests that a cross-site form could send.
 */
function checkRequest(req: http.IncomingMessage): void {
  const port = req.socket.localPort;
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowedHosts.includes(req.headers.host ?? "")) throw new HttpError(403, "Host not allowed");
  if (req.method !== "POST") return;
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    throw new HttpError(415, "POST requests must be application/json");
  }
  const origin = req.headers.origin;
  if (origin && !allowedHosts.some((h) => origin === `http://${h}`)) {
    throw new HttpError(403, "Origin not allowed");
  }
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > MAX_BODY) throw new HttpError(413, "Body too large");
  }
  try {
    const parsed: unknown = JSON.parse(body || "{}");
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    // Fall through to the 400 below.
  }
  throw new HttpError(400, "Body must be a JSON object");
}

/** Errors from user input (bad snapshot names, unknown snapshots) are client errors. */
function badRequest<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}

function routes(options: ServerOptions): Record<string, Handler> {
  const { session, status } = options;
  const live = () => {
    if (status.snapshot)
      throw new HttpError(409, "Inspecting a snapshot offline; no cluster connection");
  };
  return {
    "GET /api/status": () => ({ ...status, watching: session.watching }),
    "GET /api/model": () => session.model(),
    "GET /api/timeline": () => session.timeline(),
    "GET /api/history": (_req, url) =>
      session.accountHistory(url.searchParams.get("address") ?? ""),
    "GET /api/snapshots": () => session.snapshots(),
    "GET /api/diff": (_req, url) =>
      badRequest(() =>
        session.diff(url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "live"),
      ),
    "POST /api/refresh": async () => {
      live();
      return session.refresh();
    },
    "POST /api/snapshots": async (req) => {
      const { name } = await readJson(req);
      if (typeof name !== "string") throw new HttpError(400, '"name" must be a string');
      return badRequest(() => session.saveSnapshot(name));
    },
  };
}

function serveStatic(webDir: string, url: URL, res: http.ServerResponse): void {
  const root = path.resolve(webDir);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, "Malformed URL encoding");
  }
  const requested = path.resolve(root, `.${pathname}`);
  if (requested !== root && !requested.startsWith(root + path.sep))
    throw new HttpError(403, "Forbidden");
  const isFile = fs.existsSync(requested) && fs.statSync(requested).isFile();
  // Unknown paths fall back to the single-page app.
  const file = isFile ? requested : path.join(root, "index.html");
  if (!fs.existsSync(file)) throw new HttpError(404, `Web UI not built (${root}). Run pnpm build.`);
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  fs.createReadStream(file).pipe(res);
}

function streamEvents(session: Session, req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  const listener = (event: SessionEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  session.on("event", listener);
  req.on("close", () => {
    clearInterval(heartbeat);
    session.off("event", listener);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function handle(options: ServerOptions, req: http.IncomingMessage, res: http.ServerResponse) {
  checkRequest(req);
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/api/events") return streamEvents(options.session, req, res);
  const handler = routes(options)[`${req.method} ${url.pathname}`];
  if (handler) return sendJson(res, 200, await handler(req, url));
  if (url.pathname.startsWith("/api/"))
    throw new HttpError(404, `No route ${req.method} ${url.pathname}`);
  if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
  return serveStatic(options.webDir, url, res);
}

/** Starts the loopback-only HTTP server for the web UI and its JSON/SSE API. */
export function startServer(options: ServerOptions): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    handle(options, req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (res.headersSent) return res.end();
      sendJson(res, status, { error: (error as Error).message });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve(server));
  });
}
