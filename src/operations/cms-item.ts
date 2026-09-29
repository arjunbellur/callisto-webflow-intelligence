import { stableStringify } from "../core/diff.js";
import type { Operation } from "../core/guard.js";
import type { CollectionItem, FieldData } from "../webflow/types.js";

export interface CmsItemTarget {
  collectionId: string;
  itemId: string;
  cmsLocaleId?: string;
}

export interface CmsItemState {
  fieldData: FieldData;
}

/** Merges a field patch; `null` clears a field. */
export function applyFieldPatch(state: CmsItemState, patch: FieldData): CmsItemState {
  return { fieldData: { ...state.fieldData, ...patch } };
}

export const cmsItemOp: Operation<CmsItemTarget, CmsItemState> = {
  kind: "cms.item",
  describe: (t) => `CMS item ${t.itemId} in collection ${t.collectionId}${t.cmsLocaleId ? ` (locale ${t.cmsLocaleId})` : ""}`,

  async read({ api }, t) {
    const item = await api.get<CollectionItem>(`collections/${t.collectionId}/items/${t.itemId}`, {
      cmsLocaleId: t.cmsLocaleId,
    });
    return { fieldData: item.fieldData ?? {} };
  },

  async write({ api }, t, next, before) {
    const changed: FieldData = {};
    const keys = new Set([...Object.keys(next.fieldData), ...Object.keys(before.fieldData)]);
    for (const key of keys) {
      if (stableStringify(next.fieldData[key]) !== stableStringify(before.fieldData[key])) {
        changed[key] = next.fieldData[key] ?? null;
      }
    }
    // Staged update: changes go live on the next site publish (or item publish).
    return api.patch(`collections/${t.collectionId}/items`, {
      items: [{ id: t.itemId, ...(t.cmsLocaleId ? { cmsLocaleId: t.cmsLocaleId } : {}), fieldData: changed }],
    });
  },
};
