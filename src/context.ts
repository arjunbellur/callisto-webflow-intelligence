import type { AppConfig, ClientConfig } from "./config.js";
import { AuditLog } from "./core/audit.js";
import { SnapshotStore } from "./core/snapshots.js";
import { WebflowClient } from "./webflow/client.js";

export interface ResolvedClient {
  config: ClientConfig;
  api: WebflowClient;
}

/** Shared per-process services handed to every tool. */
export class AppContext {
  readonly audit: AuditLog;
  readonly snapshots: SnapshotStore;
  private readonly apis = new Map<string, WebflowClient>();

  constructor(
    readonly config: AppConfig,
    private readonly makeApi: (token: string) => WebflowClient = (token) => new WebflowClient({ token }),
  ) {
    this.audit = new AuditLog(config.dataDir);
    this.snapshots = new SnapshotStore(config.dataDir);
  }

  get clients(): readonly ClientConfig[] {
    return this.config.registry.clients;
  }

  /** Looks up a client by alias (case-insensitive) and returns it with an authenticated API client. */
  client(alias: string): ResolvedClient {
    const key = alias.trim().toLowerCase();
    const config = this.clients.find((c) => c.alias === key);
    if (!config) {
      const known = this.clients.map((c) => c.alias).join(", ");
      throw new Error(`Unknown client "${alias}". Known clients: ${known}`);
    }
    const tokenEnv = config.tokenEnv ?? this.config.defaultTokenEnv;
    let api = this.apis.get(tokenEnv);
    if (!api) {
      const token = this.config.env[tokenEnv];
      if (!token) throw new Error(`No Webflow token for client "${config.alias}": set ${tokenEnv} in the environment.`);
      api = this.makeApi(token);
      this.apis.set(tokenEnv, api);
    }
    return { config, api };
  }
}
