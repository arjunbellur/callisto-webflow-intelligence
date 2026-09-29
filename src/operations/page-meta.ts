import { stableStringify } from "../core/diff.js";
import type { Operation } from "../core/guard.js";
import type { Page } from "../webflow/types.js";

export interface PageMetaTarget {
  pageId: string;
  /** Secondary locale id; omit for the primary locale. */
  localeId?: string;
}

export interface PageMetaState {
  title: string;
  slug: string;
  seo: { title: string | null; description: string | null };
  openGraph: {
    title: string | null;
    titleCopied: boolean;
    description: string | null;
    descriptionCopied: boolean;
  };
}

export type PageMetaPatch = {
  title?: string;
  slug?: string;
  seo?: Partial<PageMetaState["seo"]>;
  openGraph?: Partial<PageMetaState["openGraph"]>;
};

export function toPageMetaState(page: Page): PageMetaState {
  return {
    title: page.title,
    slug: page.slug,
    seo: { title: page.seo?.title ?? null, description: page.seo?.description ?? null },
    openGraph: {
      title: page.openGraph?.title ?? null,
      titleCopied: page.openGraph?.titleCopied ?? true,
      description: page.openGraph?.description ?? null,
      descriptionCopied: page.openGraph?.descriptionCopied ?? true,
    },
  };
}

/** Applies a partial patch. Setting an OG title/description implies it is no longer copied from SEO. */
export function applyPageMetaPatch(state: PageMetaState, patch: PageMetaPatch): PageMetaState {
  const og = { ...state.openGraph, ...patch.openGraph };
  if (patch.openGraph?.title !== undefined && patch.openGraph.titleCopied === undefined) og.titleCopied = false;
  if (patch.openGraph?.description !== undefined && patch.openGraph.descriptionCopied === undefined) {
    og.descriptionCopied = false;
  }
  return {
    title: patch.title ?? state.title,
    slug: patch.slug ?? state.slug,
    seo: { ...state.seo, ...patch.seo },
    openGraph: og,
  };
}

export const pageMetaOp: Operation<PageMetaTarget, PageMetaState> = {
  kind: "page.meta",
  describe: (t) => `page ${t.pageId}${t.localeId ? ` (locale ${t.localeId})` : ""} settings`,

  async read({ api }, t) {
    return toPageMetaState(await api.get<Page>(`pages/${t.pageId}`, { localeId: t.localeId }));
  },

  async write({ api }, t, next, before) {
    // Send only the top-level sections that changed to avoid touching unrelated settings (e.g. slug).
    const body: Partial<PageMetaState> = {};
    for (const key of Object.keys(next) as (keyof PageMetaState)[]) {
      if (stableStringify(next[key]) !== stableStringify(before[key])) {
        (body as Record<string, unknown>)[key] = next[key];
      }
    }
    return api.put<Page>(`pages/${t.pageId}`, body, { localeId: t.localeId });
  },
};
