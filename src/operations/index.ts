import type { Operation } from "../core/guard.js";
import { cmsItemOp } from "./cms-item.js";
import { customCodeOp } from "./custom-code.js";
import { pageMetaOp } from "./page-meta.js";

/** Operations whose snapshots can be restored with snapshot_restore, keyed by kind. */
export const restorableOps: ReadonlyMap<string, Operation<unknown, unknown>> = new Map(
  [pageMetaOp, cmsItemOp, customCodeOp].map((op) => [op.kind, op as unknown as Operation<unknown, unknown>]),
);
