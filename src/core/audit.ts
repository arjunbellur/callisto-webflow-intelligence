import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Change } from "./diff.js";

export type AuditStatus = "applied" | "failed" | "recorded";

export interface AuditEntry {
  ts: string;
  client: string;
  kind: string;
  status: AuditStatus;
  target?: unknown;
  summary?: string;
  planId?: string;
  changes?: Change[];
  snapshotId?: string;
  /** Where the change came from, e.g. "callisto" or "webflow-mcp" for externally recorded edits. */
  source: string;
  error?: string;
}

const NON_CHANGE_KINDS: ReadonlySet<string> = new Set(["site.publish", "page.dom.snapshot"]);

export interface AuditQuery {
  client?: string;
  kind?: string;
  since?: string;
  limit?: number;
}

/** Append-only JSONL audit trail. One line per change keeps writes atomic and the file greppable. */
export class AuditLog {
  readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "audit.jsonl");
  }

  async append(entry: Omit<AuditEntry, "ts"> & { ts?: string }): Promise<AuditEntry> {
    const full: AuditEntry = { ...entry, ts: entry.ts ?? new Date().toISOString() };
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(full)}\n`, "utf8");
    return full;
  }

  /**
   * Content changes recorded since a point in time (typically the site's last publish), newest first.
   * Excludes failed writes, publishes and read-only snapshots.
   */
  async changesSince(client: string, since: string | null | undefined, limit = 200): Promise<AuditEntry[]> {
    const entries = await this.query({ client, since: since ?? undefined, limit });
    return entries.filter((e) => e.status !== "failed" && !NON_CHANGE_KINDS.has(e.kind));
  }

  /** Returns matching entries, newest first. */
  async query({ client, kind, since, limit = 50 }: AuditQuery = {}): Promise<AuditEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const sinceMs = since ? Date.parse(since) : undefined;
    const out: AuditEntry[] = [];
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i];
      if (!line) continue;
      let entry: AuditEntry;
      try {
        entry = JSON.parse(line) as AuditEntry;
      } catch {
        continue; // tolerate a partially written trailing line
      }
      if (client && entry.client !== client) continue;
      if (kind && entry.kind !== kind) continue;
      if (sinceMs !== undefined && Date.parse(entry.ts) < sinceMs) break; // file is chronological
      out.push(entry);
    }
    return out;
  }
}
