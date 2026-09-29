/** Shared helpers for the local scripts (setup, token). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { WebflowClient } from "../src/webflow/client.js";
import { WebflowApiError } from "../src/webflow/errors.js";
import type { Site } from "../src/webflow/types.js";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const envFile = path.join(root, ".env");
export const TOKEN_VAR = "WEBFLOW_API_TOKEN";

export const log = (msg: string) => console.log(`\x1b[36m›\x1b[0m ${msg}`);
export const done = (msg: string) => console.log(`\x1b[32m✔\x1b[0m ${msg}`);
export const warn = (msg: string) => console.log(`\x1b[33m!\x1b[0m ${msg}`);
export const fail = (msg: string): never => {
  console.error(`\x1b[31m✖\x1b[0m ${msg}`);
  process.exit(1);
};

/** Prompts on the terminal; hides typed characters when `secret` is true. */
export function prompt(question: string, secret = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl as unknown as { _writeToOutput: (s: string) => void };
    const original = output._writeToOutput;
    if (secret) output._writeToOutput = (s) => (s.includes(question) ? original.call(rl, question) : undefined);
    rl.question(question, (answer) => {
      rl.close();
      if (secret) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

export function readEnvToken(): string | undefined {
  if (!existsSync(envFile)) return undefined;
  const line = readFileSync(envFile, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${TOKEN_VAR}=`));
  const value = line?.slice(TOKEN_VAR.length + 1).trim().replace(/^["']|["']$/g, "");
  return value || undefined;
}

export function writeEnvToken(token: string): void {
  const template = existsSync(envFile)
    ? readFileSync(envFile, "utf8")
    : readFileSync(path.join(root, ".env.example"), "utf8");
  const lines = template.split("\n");
  const idx = lines.findIndex((l) => l.startsWith(`${TOKEN_VAR}=`));
  const entry = `${TOKEN_VAR}=${token}`;
  if (idx >= 0) lines[idx] = entry;
  else lines.unshift(entry);
  writeFileSync(envFile, lines.join("\n"), "utf8");
}

export type TokenCheck = { ok: true; sites: Site[] } | { ok: false; reason: string };

/** Asks Webflow whether the token can list sites; explains the failure in plain words. */
export async function checkToken(token: string): Promise<TokenCheck> {
  if (!/^[A-Za-z0-9._-]{20,}$/.test(token)) {
    return { ok: false, reason: `That doesn't look like a Webflow token (${token.length} chars, unexpected characters).` };
  }
  try {
    const sites = (await new WebflowClient({ token }).get<{ sites: Site[] }>("sites")).sites ?? [];
    if (sites.length === 0) {
      return { ok: false, reason: "Token is valid but reaches no sites. Authorize it for at least one site in Webflow." };
    }
    return { ok: true, sites };
  } catch (err) {
    if (!(err instanceof WebflowApiError)) throw err;
    if (err.status === 401) return { ok: false, reason: "Webflow says the token is invalid (401). Check for a truncated paste." };
    if (err.code === "missing_scopes") {
      return {
        ok: false,
        reason:
          "Webflow accepted the token but it has no site scopes (403 missing_scopes). Scopes are fixed at creation: " +
          "generate a new token on the API access page (site or workspace settings) with Sites, Pages, CMS and " +
          "Custom code set to read and write. Tokens from the Apps/Develop screen are OAuth clients and won't work here.",
      };
    }
    return { ok: false, reason: err.message };
  }
}

/**
 * Obtains a working token: tries `existing` first, then prompts until a token passes the check
 * or the user gives up (empty input). Saves to .env on success.
 */
export async function ensureToken(existing?: string): Promise<{ token: string; sites: Site[] }> {
  let candidate = existing;
  for (;;) {
    if (candidate) {
      const result = await checkToken(candidate);
      if (result.ok) {
        writeEnvToken(candidate);
        return { token: candidate, sites: result.sites };
      }
      warn(result.reason);
    }
    console.log("\nCreate a token in Webflow: Site or Workspace settings › Apps & integrations › API access.");
    console.log("Scopes: Sites, Pages, CMS, Custom code (read and write). Press Enter with no input to quit.");
    candidate = await prompt(`Paste your ${TOKEN_VAR}: `, true);
    if (!candidate) fail("No token provided.");
  }
}
