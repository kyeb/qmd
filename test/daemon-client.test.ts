/**
 * Unit tests for the CLI daemon fast path (cli/daemon-client.ts). Every
 * failure mode resolves to null, never throws.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonBaseUrl,
  daemonDisabledByEnv,
  discoverDaemon,
  probeDaemon,
  readDaemonDiscovery,
  searchViaDaemon,
} from "../src/cli/daemon-client.ts";

describe("daemonDisabledByEnv", () => {
  test("falsy values keep routing on, anything else opts out", () => {
    expect(daemonDisabledByEnv({} as NodeJS.ProcessEnv)).toBe(false);
    for (const v of ["", "0", "false", "no", "off", " 0 "]) {
      expect(daemonDisabledByEnv({ QMD_NO_DAEMON: v } as NodeJS.ProcessEnv)).toBe(false);
    }
    for (const v of ["1", "true", "yes", "on", "anything"]) {
      expect(daemonDisabledByEnv({ QMD_NO_DAEMON: v } as NodeJS.ProcessEnv)).toBe(true);
    }
  });
});

describe("readDaemonDiscovery", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "qmd-daemon-client-")); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  test("missing file is null", () => {
    expect(readDaemonDiscovery(join(dir, "nope.port"))).toBeNull();
  });

  test("malformed or incomplete file is null", () => {
    const p = join(dir, "bad.port");
    writeFileSync(p, "not json");
    expect(readDaemonDiscovery(p)).toBeNull();
    writeFileSync(p, JSON.stringify({ port: "8181", dbPath: "/x", pid: 1 }));
    expect(readDaemonDiscovery(p)).toBeNull();
    writeFileSync(p, JSON.stringify({ port: 8181, pid: 1 }));
    expect(readDaemonDiscovery(p)).toBeNull();
  });

  test("valid file round-trips and defaults host to localhost", () => {
    const p = join(dir, "good.port");
    writeFileSync(p, JSON.stringify({ port: 8181, dbPath: "/x/index.sqlite", pid: 42 }));
    expect(readDaemonDiscovery(p)).toEqual({ port: 8181, host: "localhost", dbPath: "/x/index.sqlite", pid: 42 });
  });
});

describe("daemonBaseUrl", () => {
  test("wildcard binds are reached over localhost; IPv6 literals get brackets", () => {
    expect(daemonBaseUrl({ host: "localhost", port: 8181 })).toBe("http://localhost:8181");
    expect(daemonBaseUrl({ host: "0.0.0.0", port: 8181 })).toBe("http://localhost:8181");
    expect(daemonBaseUrl({ host: "::1", port: 8181 })).toBe("http://[::1]:8181");
  });
});

describe("probeDaemon / discoverDaemon / searchViaDaemon against a fake daemon", () => {
  let server: Server;
  let port: number;
  let dir: string;
  let healthBody: Record<string, unknown> = { status: "ok", dbPath: "/idx/index.sqlite", pid: 1 };
  let healthDelayMs = 0;
  let searchStatus = 200;
  let searchBody = "{}";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "qmd-daemon-fake-"));
    server = createServer((req, res) => {
      if (req.url === "/health") {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(healthBody));
        }, healthDelayMs);
        return;
      }
      if (req.url === "/v1/search") {
        res.writeHead(searchStatus, { "Content-Type": "application/json" });
        res.end(searchBody);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const discovery = () => ({ port, host: "127.0.0.1", dbPath: "/idx/index.sqlite", pid: 1 });

  test("routes when /health reports the same dbPath", async () => {
    healthBody = { status: "ok", dbPath: "/idx/index.sqlite", pid: 1 };
    await expect(probeDaemon(discovery(), "/idx/index.sqlite")).resolves.toBe(`http://127.0.0.1:${port}`);
  });

  test("refuses a different index or a /health without dbPath", async () => {
    healthBody = { status: "ok", dbPath: "/other/index.sqlite", pid: 1 };
    await expect(probeDaemon(discovery(), "/idx/index.sqlite")).resolves.toBeNull();
    healthBody = { status: "ok", uptime: 3 };
    await expect(probeDaemon(discovery(), "/idx/index.sqlite")).resolves.toBeNull();
  });

  test("slow or absent daemon is null, not an error", async () => {
    healthBody = { status: "ok", dbPath: "/idx/index.sqlite", pid: 1 };
    healthDelayMs = 300;
    try {
      await expect(probeDaemon(discovery(), "/idx/index.sqlite", 50)).resolves.toBeNull();
    } finally {
      healthDelayMs = 0;
    }
    await expect(probeDaemon({ port: 1, host: "127.0.0.1", dbPath: "/idx/index.sqlite", pid: 1 }, "/idx/index.sqlite")).resolves.toBeNull();
  });

  test("discoverDaemon: missing file, then a matching file", async () => {
    healthBody = { status: "ok", dbPath: "/idx/index.sqlite", pid: 1 };
    const portPath = join(dir, "mcp.port");
    await expect(discoverDaemon(portPath, "/idx/index.sqlite")).resolves.toBeNull();
    writeFileSync(portPath, JSON.stringify(discovery()));
    await expect(discoverDaemon(portPath, "/idx/index.sqlite")).resolves.toBe(`http://127.0.0.1:${port}`);
    await expect(discoverDaemon(portPath, "/elsewhere/index.sqlite")).resolves.toBeNull();
  });

  test("searchViaDaemon: 500 and malformed payload are null, rows pass through", async () => {
    const base = `http://127.0.0.1:${port}`;
    const request = { mode: "vsearch" as const, query: "x", limit: 5, minScore: 0.3 };
    searchStatus = 500; searchBody = "boom";
    await expect(searchViaDaemon(base, request)).resolves.toBeNull();
    searchStatus = 200; searchBody = JSON.stringify({ nope: true });
    await expect(searchViaDaemon(base, request)).resolves.toBeNull();
    searchStatus = 200; searchBody = JSON.stringify({ results: [{ file: "qmd://c/a.md", displayPath: "a.md", title: "A", body: "", score: 1, context: null, docid: "abc123", metadata: {} }] });
    const rows = await searchViaDaemon(base, request);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.docid).toBe("abc123");
  });
});
