import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspace, Session, type Snapshot, type XrayModel } from "@anchorx-ray/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startServer } from "./server.js";

const fixtures = fileURLToPath(new URL("../../core/test/fixtures", import.meta.url));

interface Reply {
  status: number;
  body: string;
}

function request(port: number, options: http.RequestOptions & { body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, ...options }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += String(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("UI server", () => {
  let server: http.Server;
  let port: number;
  let root: string;
  const get = (p: string, headers: http.OutgoingHttpHeaders = {}) =>
    request(port, { path: p, headers: { host: `127.0.0.1:${port}`, ...headers } });
  const post = (p: string, body: string, headers: http.OutgoingHttpHeaders = {}) =>
    request(port, {
      method: "POST",
      path: p,
      body,
      headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", ...headers },
    });

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "xray-server-"));
    const webDir = path.join(root, "web");
    fs.mkdirSync(webDir);
    fs.writeFileSync(path.join(webDir, "index.html"), "<!doctype html><title>ui</title>");
    fs.writeFileSync(path.join(root, "secret.txt"), "secret");
    const workspace = loadWorkspace({
      root,
      idlPaths: ["xray_vault.json", "xray_registry.json"].map((f) => path.join(fixtures, f)),
    });
    const session = new Session({ workspace, rpcUrl: "http://127.0.0.1:1", txLimit: 0 });
    const snapshot = JSON.parse(fs.readFileSync(path.join(fixtures, "demo-snapshot.json"), "utf8"));
    session.load(snapshot as Snapshot);
    const status = { rpcUrl: "x", cluster: "localnet", root, snapshot: "demo", warnings: [] };
    server = await startServer({ session, status, webDir, port: 0 });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("serves the model and timeline as JSON", async () => {
    const model = await get("/api/model");
    expect(model.status).toBe(200);
    expect((JSON.parse(model.body) as XrayModel).programs).toHaveLength(2);
    expect(JSON.parse((await get("/api/timeline")).body).length).toBeGreaterThan(5);
    expect(JSON.parse((await get("/api/status")).body)).toMatchObject({
      snapshot: "demo",
      watching: false,
    });
  });

  test("rejects foreign Host headers (DNS rebinding)", async () => {
    expect((await get("/api/model", { host: "attacker.example" })).status).toBe(403);
    expect((await get("/api/model", { host: `localhost:${port}` })).status).toBe(200);
  });

  test("only accepts same-origin JSON POSTs", async () => {
    const body = JSON.stringify({ name: "x" });
    expect((await post("/api/snapshots", body, { "content-type": "text/plain" })).status).toBe(415);
    expect(
      (await post("/api/snapshots", body, { origin: "https://attacker.example" })).status,
    ).toBe(403);
    expect((await post("/api/snapshots", "not json")).status).toBe(400);
    expect((await post("/api/snapshots", JSON.stringify({ name: 3 }))).status).toBe(400);
  });

  test("saves and diffs snapshots, validating names", async () => {
    const saved = await post("/api/snapshots", JSON.stringify({ name: "copy" }), {
      origin: `http://127.0.0.1:${port}`,
    });
    expect(saved.status).toBe(200);
    expect(fs.existsSync(path.join(root, ".anchorx-ray", "snapshots", "copy.json"))).toBe(true);
    expect((await post("/api/snapshots", JSON.stringify({ name: "../x" }))).status).toBe(400);
    const diff = await get("/api/diff?from=copy&to=live");
    expect(JSON.parse(diff.body).accounts).toEqual([]);
    expect((await get("/api/diff?from=absent")).status).toBe(400);
  });

  test("refuses to rescan while inspecting a snapshot", async () => {
    expect((await post("/api/refresh", "{}")).status).toBe(409);
  });

  test("serves the UI but nothing outside its directory", async () => {
    expect((await get("/")).body).toContain("<title>ui</title>");
    expect((await get("/some/client/route")).body).toContain("<title>ui</title>");
    expect((await get("/..%2fsecret.txt")).status).toBe(403);
    expect((await get("/api/nope")).status).toBe(404);
    expect(
      (await request(port, { method: "DELETE", path: "/", headers: { host: `127.0.0.1:${port}` } }))
        .status,
    ).toBe(405);
  });
});
