import type { AppContext, ResolvedClient } from "../context.js";
import { type Change, diff, hash } from "./diff.js";

/**
 * A reversible write against Webflow, described as "read current state" + "write desired state".
 * Because both directions use the same state shape, any applied change can be rolled back by
 * writing the snapshot's `before` state through the same guarded path.
 */
export interface Operation<TTarget, TState> {
  kind: string;
  describe(target: TTarget): string;
  read(client: ResolvedClient, target: TTarget): Promise<TState>;
  write(client: ResolvedClient, target: TTarget, next: TState, before: TState): Promise<unknown>;
}

export class GuardError extends Error {
  override name = "GuardError";
}

export type GuardResult =
  | { status: "noop"; kind: string; target: string; message: string }
  | {
      status: "planned";
      kind: string;
      target: string;
      planId: string;
      changes: Change[];
      message: string;
    }
  | {
      status: "applied";
      kind: string;
      target: string;
      planId: string;
      changes: Change[];
      snapshotId: string;
      result: unknown;
      message: string;
    };

export interface GuardedWriteInput<TTarget, TState> {
  ctx: AppContext;
  clientAlias: string;
  op: Operation<TTarget, TState>;
  target: TTarget;
  /** Computes the desired state from the live state. Must be pure and deterministic. */
  propose: (before: TState) => TState;
  confirm?: boolean;
  planId?: string;
  summary?: string;
}

/**
 * Two-phase write protocol:
 *  1. Without `confirm`: read live state, compute the proposal, return the diff and a `planId`.
 *     Nothing is written.
 *  2. With `confirm` + `planId`: re-read live state and recompute. The plan id is a hash of the
 *     operation, target, live state and proposal, so it only matches if neither the arguments nor
 *     the site changed since the dry run (optimistic concurrency). Then snapshot, write, audit.
 */
export async function guardedWrite<TTarget, TState>(input: GuardedWriteInput<TTarget, TState>): Promise<GuardResult> {
  const { ctx, op, target, propose } = input;
  const client = ctx.client(input.clientAlias);
  const alias = client.config.alias;
  const label = op.describe(target);

  const before = await op.read(client, target);
  const proposed = propose(before);
  const changes = diff(before, proposed);
  if (changes.length === 0) {
    return { status: "noop", kind: op.kind, target: label, message: "Live state already matches; nothing to do." };
  }

  const planId = hash({ kind: op.kind, alias, target, before, proposed });
  if (!input.confirm) {
    return {
      status: "planned",
      kind: op.kind,
      target: label,
      planId,
      changes,
      message: "Dry run only. Review the changes, then call again with confirm: true and this planId to apply.",
    };
  }

  if (client.config.readOnly) {
    throw new GuardError(`Client "${alias}" is marked readOnly in the registry; refusing to write.`);
  }
  if (!input.planId) {
    throw new GuardError("confirm: true requires the planId returned by the dry run.");
  }
  if (input.planId !== planId) {
    throw new GuardError(
      "planId does not match: the arguments or the live site changed since the dry run. Run the dry run again.",
    );
  }

  const snapshot = await ctx.snapshots.save({ client: alias, kind: op.kind, target, before, after: proposed, planId });
  try {
    const result = await op.write(client, target, proposed, before);
    await ctx.audit.append({
      client: alias,
      kind: op.kind,
      status: "applied",
      source: "callisto",
      target,
      summary: input.summary ?? label,
      planId,
      changes,
      snapshotId: snapshot.id,
    });
    return {
      status: "applied",
      kind: op.kind,
      target: label,
      planId,
      changes,
      snapshotId: snapshot.id,
      result,
      message: "Applied to staging (not yet published). Use snapshot_restore with snapshotId to roll back.",
    };
  } catch (err) {
    await ctx.audit.append({
      client: alias,
      kind: op.kind,
      status: "failed",
      source: "callisto",
      target,
      summary: input.summary ?? label,
      planId,
      changes,
      snapshotId: snapshot.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
