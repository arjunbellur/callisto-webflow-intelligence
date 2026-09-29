#!/usr/bin/env tsx
/**
 * One-time OAuth authorization: turns a Webflow App into a single token that covers every site
 * in the workspace you authorize it for.
 *
 *   npm run auth
 *
 * Prerequisite, done once in Webflow: Workspace settings › Apps & integrations › Develop ›
 * Create an app (type: Data client). Set the redirect URI to http://localhost:8787/callback and
 * enable the scopes listed in SCOPES below. Copy its Client ID and Client Secret.
 *
 * The script starts a local callback server, opens the Webflow authorize page (choose "all sites"
 * when asked), exchanges the returned code for an access token, verifies it, and saves it to .env.
 * Webflow access tokens do not expire unless revoked.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { done, ensureToken, envFile, fail, log, prompt, readEnvVar, warn, writeEnvVar } from "./lib.js";

const PORT = Number(process.env.CALLISTO_AUTH_PORT ?? 8787);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const AUTHORIZE_URL = "https://webflow.com/oauth/authorize";
const TOKEN_URL = "https://api.webflow.com/oauth/access_token";

/** Scopes requested. Every one of these must be enabled on the app in Webflow. */
const SCOPES = [
  "authorized_user:read",
  "sites:read",
  "sites:write",
  "pages:read",
  "pages:write",
  "cms:read",
  "cms:write",
  "custom_code:read",
  "custom_code:write",
  "assets:read",
  "forms:read",
];

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
}

/** Serves the callback once and resolves with the authorization code. */
function waitForCode(state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, html: string, outcome: () => void) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(html);
        server.close();
        outcome();
      };
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error) return finish(400, page("Authorization failed", error), () => reject(new Error(`Webflow returned: ${error}`)));
      if (url.searchParams.get("state") !== state) {
        return finish(400, page("State mismatch", "Start again."), () => reject(new Error("OAuth state mismatch")));
      }
      if (!code) return finish(400, page("Missing code", ""), () => reject(new Error("No code in callback")));
      finish(200, page("Authorized", "You can close this tab and return to the terminal."), () => resolve(code));
    });
    server.on("error", (err) => reject(new Error(`Could not listen on port ${PORT}: ${err.message}`)));
    server.listen(PORT, "127.0.0.1");
  });
}

const page = (title: string, body: string) =>
  `<!doctype html><title>${title}</title><body style="font-family:system-ui;padding:3rem"><h1>${title}</h1><p>${body}</p></body>`;

async function exchangeCode(clientId: string, clientSecret: string, code: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; message?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`Token exchange failed (${res.status}): ${body.error_description ?? body.message ?? "unknown error"}`);
  }
  return body.access_token;
}

async function main(): Promise<void> {
  console.log("Webflow App credentials (Workspace settings › Apps & integrations › Develop › your app).");
  console.log(`The app's redirect URI must be exactly ${REDIRECT_URI}\n`);

  let clientId = process.env.WEBFLOW_CLIENT_ID || readEnvVar("WEBFLOW_CLIENT_ID");
  let clientSecret = process.env.WEBFLOW_CLIENT_SECRET || readEnvVar("WEBFLOW_CLIENT_SECRET");
  if (clientId && clientSecret) {
    log(`Using client id ${clientId.slice(0, 6)}… from .env`);
  } else {
    clientId = await prompt("Client ID: ");
    clientSecret = await prompt("Client Secret: ", true);
    if (!clientId || !clientSecret) fail("Client ID and secret are both required.");
    writeEnvVar("WEBFLOW_CLIENT_ID", clientId);
    writeEnvVar("WEBFLOW_CLIENT_SECRET", clientSecret);
  }

  const state = randomBytes(16).toString("hex");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", state);

  const pending = waitForCode(state);
  log("Opening the Webflow authorization page. Choose the workspace and select all sites.");
  console.log(`If the browser does not open, visit:\n${url.toString()}\n`);
  openBrowser(url.toString());

  const code = await pending;
  log("Exchanging the authorization code for a token…");
  const token = await exchangeCode(clientId, clientSecret, code);

  const { sites } = await ensureToken(token);
  done(`Token works and reaches ${sites.length} site(s). Saved to ${envFile}.`);
  for (const s of sites) console.log(`  ${s.displayName}  (${s.id})`);
  if (sites.length === 0) warn("No sites: re-run and pick sites on the authorization screen.");
  console.log("\nNext: npm run setup");
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
