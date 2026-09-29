import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Snapshot<TTarget = unknown, TState = unknown> {
  id: string;
  ts: string;
  client: string;
  kind: string;
  target: TTarget;
  before: TState;
  after?: TState;
  planId?: string;
}

const SNAPSHOT_ID = /^[a-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** Stores pre-change state as JSON files: <dataDir>/snapshots/<client>/<id>.json */
export class SnapshotStore {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "snapshots");
  }

  async save<TTarget, TState>(input: Omit<Snapshot<TTarget, TState>, "id" | "ts">): Promise<Snapshot<TTarget, TState>> {
    const ts = new Date().toISOString();
    const stamp = ts.replace(/[:.]/g, "-");
    const suffix = input.planId ?? Math.random().toString(36).slice(2, 10);
    const id = `${input.client}/${stamp}_${input.kind.replace(/[^a-z0-9]+/gi, "-")}_${suffix}`;
    const snapshot: Snapshot<TTarget, TState> = { ...input, id, ts };
    const file = this.fileFor(id);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(snapshot, null, 2), { encoding: "utf8", flag: "wx" });
    return snapshot;
  }

  async load(id: string): Promise<Snapshot> {
    return JSON.parse(await readFile(this.fileFor(id), "utf8")) as Snapshot;
  }

  private fileFor(id: string): string {
    if (!SNAPSHOT_ID.test(id)) throw new Error(`Invalid snapshot id "${id}"`);
    const file = path.resolve(this.root, `${id}.json`);
    if (!file.startsWith(this.root + path.sep)) throw new Error(`Invalid snapshot id "${id}"`);
    return file;
  }
}
