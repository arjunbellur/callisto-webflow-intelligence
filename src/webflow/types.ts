/**
 * Minimal Webflow Data API v2 shapes. Only fields this server reads are typed;
 * responses may carry more, which pass through untouched.
 */

export interface Pagination {
  limit: number;
  offset: number;
  total: number;
}

export interface CustomDomain {
  id: string;
  url: string;
  lastPublished?: string | null;
}

export interface Site {
  id: string;
  workspaceId?: string;
  displayName: string;
  shortName: string;
  previewUrl?: string;
  lastPublished?: string | null;
  lastUpdated?: string;
  customDomains?: CustomDomain[];
  locales?: {
    primary?: { id: string; cmsLocaleId?: string; displayName?: string; tag?: string };
    secondary?: { id: string; cmsLocaleId?: string; displayName?: string; tag?: string }[];
  };
}

export interface PageSeo {
  title?: string | null;
  description?: string | null;
}

export interface PageOpenGraph {
  title?: string | null;
  titleCopied?: boolean;
  description?: string | null;
  descriptionCopied?: boolean;
}

export interface Page {
  id: string;
  siteId: string;
  title: string;
  slug: string;
  parentId?: string | null;
  collectionId?: string | null;
  publishedPath?: string;
  draft?: boolean;
  archived?: boolean;
  lastUpdated?: string;
  seo?: PageSeo;
  openGraph?: PageOpenGraph;
}

export interface CollectionField {
  id: string;
  slug: string;
  displayName: string;
  type: string;
  isRequired?: boolean;
  isEditable?: boolean;
}

export interface Collection {
  id: string;
  displayName: string;
  singularName: string;
  slug: string;
  lastUpdated?: string;
  fields?: CollectionField[];
}

export type FieldData = Record<string, unknown>;

export interface CollectionItem {
  id: string;
  cmsLocaleId?: string;
  isDraft?: boolean;
  isArchived?: boolean;
  lastPublished?: string | null;
  lastUpdated?: string;
  fieldData: FieldData;
}

export interface RegisteredScript {
  id: string;
  displayName: string;
  version: string;
  hostedLocation?: string;
  integrityHash?: string;
  canCopy?: boolean;
  createdOn?: string;
  lastUpdated?: string;
}

export type ScriptLocation = "header" | "footer";

export interface AppliedScript {
  id: string;
  location: ScriptLocation;
  version: string;
  attributes?: Record<string, unknown>;
}

export interface DomNode {
  id: string;
  type: string;
  text?: { html?: string | null; text?: string | null };
  [key: string]: unknown;
}
