/**
 * CLI fast path through a running `qmd mcp --http`.
 *
 * `qmd query` and `qmd vsearch` pay the model cold-load on every call. When
 * the HTTP server is already serving the same index those models are warm, so
 * the CLI hands the search to it over loopback. Discovery is the `mcp.port`
 * file the server writes next to `mcp.pid`; the CLI probes `/health` and
 * routes only if the reported dbPath matches its own. Everything in here
 * returns null on failure so callers fall through to the in-process search.
 */

import { readFileSync, realpathSync } from "node:fs";
import type { ChunkStrategy, ExpandedQuery } from "../store.js";
import type { MetadataFilter } from "../metadata-filter.js";

export type DaemonDiscovery = {
  port: number;
  host: string;
  dbPath: string;
  pid: number;
};

export type DaemonSearchMode = "vsearch" | "query";

/** Body of `POST /v1/search`: the CLI's already-resolved options. */
export type DaemonSearchRequest = {
  mode: DaemonSearchMode;
  query: string;
  /** Pre-parsed `lex:`/`vec:`/`hyde:` lines (query mode only). */
  searches?: ExpandedQuery[];
  collections?: string[];
  filter?: MetadataFilter;
  limit: number;
  minScore: number;
  candidateLimit?: number;
  skipRerank?: boolean;
  explain?: boolean;
  intent?: string;
  chunkStrategy?: ChunkStrategy;
};

export type DaemonSearchResult = {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
  context: string | null;
  docid: string;
  metadata: Record<string, unknown>;
  bestChunkPos?: number;
  bestChunkLen?: number;
  explain?: unknown;
};

export const DAEMON_HEALTH_TIMEOUT_MS = 200;

export function daemonDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.QMD_NO_DAEMON?.trim().toLowerCase();
  return !!raw && !["0", "false", "no", "off"].includes(raw);
}

function debug(msg: string): void {
  if (process.env.QMD_DEBUG) process.stderr.write(`[daemon] ${msg}\n`);
}

export function readDaemonDiscovery(portPath: string): DaemonDiscovery | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(portPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const d = parsed as Record<string, unknown>;
    if (typeof d.port !== "number" || typeof d.dbPath !== "string" || typeof d.pid !== "number") return null;
    return {
      port: d.port,
      host: typeof d.host === "string" && d.host ? d.host : "localhost",
      dbPath: d.dbPath,
      pid: d.pid,
    };
  } catch {
    return null;
  }
}

function sameDbPath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

// Wildcard binds are reached over loopback; bare IPv6 literals need brackets.
function urlHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "localhost";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function daemonBaseUrl(d: Pick<DaemonDiscovery, "host" | "port">): string {
  return `http://${urlHost(d.host)}:${d.port}`;
}

/** Base URL if the daemon answers `/health` in time and serves `expectedDbPath`. */
export async function probeDaemon(
  discovery: DaemonDiscovery,
  expectedDbPath: string,
  timeoutMs: number = DAEMON_HEALTH_TIMEOUT_MS,
): Promise<string | null> {
  const baseUrl = daemonBaseUrl(discovery);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    if (!res.ok) {
      debug(`${baseUrl}/health returned ${res.status}`);
      return null;
    }
    const health = (await res.json()) as { dbPath?: unknown };
    if (typeof health.dbPath !== "string") {
      debug(`${baseUrl} predates daemon routing (no dbPath in /health)`);
      return null;
    }
    if (!sameDbPath(health.dbPath, expectedDbPath)) {
      debug(`${baseUrl} serves ${health.dbPath}, not ${expectedDbPath}`);
      return null;
    }
    return baseUrl;
  } catch (err) {
    debug(`${baseUrl}/health unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverDaemon(portPath: string, dbPath: string): Promise<string | null> {
  const discovery = readDaemonDiscovery(portPath);
  if (!discovery) return null;
  const baseUrl = await probeDaemon(discovery, dbPath);
  if (baseUrl) debug(`routing via ${baseUrl} (PID ${discovery.pid})`);
  return baseUrl;
}

export async function searchViaDaemon(
  baseUrl: string,
  request: DaemonSearchRequest,
  timeoutMs: number = 10 * 60 * 1000,
): Promise<DaemonSearchResult[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/v1/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!res.ok) {
      debug(`POST /v1/search returned ${res.status}`);
      return null;
    }
    const payload = (await res.json()) as { results?: unknown };
    if (!Array.isArray(payload.results)) {
      debug("POST /v1/search returned no results array");
      return null;
    }
    return payload.results as DaemonSearchResult[];
  } catch (err) {
    debug(`POST /v1/search failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
