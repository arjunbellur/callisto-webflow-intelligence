import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AppConfig, parseRegistry } from "../src/config.js";
import { AppContext } from "../src/context.js";
import { WebflowClient } from "../src/webflow/client.js";

export const SITE_ID = "a".repeat(24);
export const PAGE_ID = "b".repeat(24);

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (method: string, path: string, body: unknown) => { status?: number; json?: unknown } | undefined;

/** Builds a fetch implementation backed by a route handler, recording every call. */
export function fakeFetch(handler: Handler) {
  const calls: Recorded[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const p = url.pathname.replace(/^\/v2\//, "");
    calls.push({ method, path: p, body });
    const res = handler(method, p, body);
    if (!res) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return new Response(res.json === undefined ? null : JSON.stringify(res.json), { status: res.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

export function makeContext(handler: Handler, opts: { readOnly?: boolean } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "callisto-test-"));
  const config: AppConfig = {
    registry: parseRegistry({
      clients: [{ alias: "acme", name: "Acme", siteId: SITE_ID, liveUrl: "https://acme.test", readOnly: opts.readOnly ?? false }],
    }),
    registryPath: "(test)",
    dataDir,
    defaultTokenEnv: "WEBFLOW_API_TOKEN",
    env: { WEBFLOW_API_TOKEN: "test-token" },
  };
  const fetch = fakeFetch(handler);
  const ctx = new AppContext(config, (token) => new WebflowClient({ token, fetchImpl: fetch.impl, sleep: async () => {} }));
  return { ctx, calls: fetch.calls, dataDir };
}
