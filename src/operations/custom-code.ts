import type { Operation } from "../core/guard.js";
import { WebflowApiError } from "../webflow/errors.js";
import type { AppliedScript, RegisteredScript, ScriptLocation } from "../webflow/types.js";

export type CustomCodeTarget =
  | { scope: "site"; siteId: string; pendingScript?: PendingScript }
  | { scope: "page"; siteId: string; pageId: string; pendingScript?: PendingScript };

/** An inline script that is registered with Webflow only when the plan is confirmed. */
export interface PendingScript {
  displayName: string;
  version: string;
  sourceCode: string;
}

export type CustomCodeState = AppliedScript[];

const PENDING_PREFIX = "pending:";

export const pendingId = (s: Pick<PendingScript, "displayName" | "version">) =>
  `${PENDING_PREFIX}${s.displayName}@${s.version}`;

const basePath = (t: CustomCodeTarget) =>
  t.scope === "site" ? `sites/${t.siteId}/custom_code` : `pages/${t.pageId}/custom_code`;

function normalize(scripts: AppliedScript[] | undefined): CustomCodeState {
  return (scripts ?? []).map((s) => ({
    id: s.id,
    location: s.location,
    version: s.version,
    ...(s.attributes && Object.keys(s.attributes).length ? { attributes: s.attributes } : {}),
  }));
}

export interface UpsertInput {
  current: CustomCodeState;
  registered: RegisteredScript[];
  displayName: string;
  version: string;
  location: ScriptLocation;
  attributes?: Record<string, unknown>;
}

/**
 * Computes the applied-script list after upserting a script by display name: any applied version of
 * the same script is replaced in place; otherwise it is appended. Reuses an already-registered
 * script with the same name and version; otherwise returns a pending placeholder to register on apply.
 */
export function upsertScript(input: UpsertInput): { next: CustomCodeState; reused: RegisteredScript | undefined } {
  const nameById = new Map(input.registered.map((r) => [r.id, r.displayName]));
  const reused = input.registered.find((r) => r.displayName === input.displayName && r.version === input.version);
  const entry: AppliedScript = {
    id: reused?.id ?? pendingId(input),
    location: input.location,
    version: input.version,
    ...(input.attributes && Object.keys(input.attributes).length ? { attributes: input.attributes } : {}),
  };
  const idx = input.current.findIndex((s) => nameById.get(s.id) === input.displayName);
  const next = [...input.current];
  if (idx >= 0) next[idx] = entry;
  else next.push(entry);
  return { next, reused };
}

export const customCodeOp: Operation<CustomCodeTarget, CustomCodeState> = {
  kind: "custom-code",
  describe: (t) => (t.scope === "site" ? `site ${t.siteId} custom code` : `page ${t.pageId} custom code`),

  async read({ api }, t) {
    try {
      return normalize((await api.get<{ scripts?: AppliedScript[] }>(basePath(t))).scripts);
    } catch (err) {
      if (err instanceof WebflowApiError && err.status === 404) return [];
      throw err;
    }
  },

  async write({ api }, t, next) {
    const scripts: AppliedScript[] = [];
    for (const script of next) {
      if (!script.id.startsWith(PENDING_PREFIX)) {
        scripts.push(script);
        continue;
      }
      const pending = t.pendingScript;
      if (!pending || pendingId(pending) !== script.id) {
        throw new Error(`No source registered for placeholder ${script.id}`);
      }
      const registered = await api.post<RegisteredScript>(`sites/${t.siteId}/registered_scripts/inline`, {
        displayName: pending.displayName,
        version: pending.version,
        sourceCode: pending.sourceCode,
      });
      scripts.push({ ...script, id: registered.id });
    }
    if (scripts.length === 0) return api.delete(basePath(t));
    return api.put(basePath(t), { scripts });
  },
};
