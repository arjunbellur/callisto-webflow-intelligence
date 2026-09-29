const MAX_BYTES = 5 * 1024 * 1024;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

function metaContent(html: string, attr: "name" | "property", key: string): string | null {
  const tag = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*>`, "i").exec(html)?.[0];
  const content = tag ? /content=["']([^"']*)["']/i.exec(tag)?.[1] : undefined;
  return content === undefined ? null : decodeEntities(content);
}

export interface LiveCheck {
  url: string;
  status: number;
  ok: boolean;
  title: string | null;
  metaDescription: string | null;
  ogTitle: string | null;
  checks: { text: string; expected: "present" | "absent"; found: boolean; pass: boolean }[];
}

/** Fetches a URL with a cache-busting parameter and evaluates presence/absence checks. */
export async function checkLivePage(
  url: URL,
  expect: string[],
  absent: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<LiveCheck> {
  const target = new URL(url);
  target.searchParams.set("_callisto", Date.now().toString(36));
  const res = await fetchImpl(target, {
    headers: { "Cache-Control": "no-cache", "User-Agent": "callisto-mcp/verify" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  const buf = await res.arrayBuffer();
  const html = new TextDecoder().decode(buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf);
  const decoded = decodeEntities(html);
  const contains = (s: string) => html.includes(s) || decoded.includes(s);

  const checks = [
    ...expect.map((text) => ({ text, expected: "present" as const, found: contains(text) })),
    ...absent.map((text) => ({ text, expected: "absent" as const, found: contains(text) })),
  ].map((c) => ({ ...c, pass: c.expected === "present" ? c.found : !c.found }));

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return {
    url: url.toString(),
    status: res.status,
    ok: res.ok && checks.every((c) => c.pass),
    title: title === undefined ? null : decodeEntities(title.trim()),
    metaDescription: metaContent(html, "name", "description"),
    ogTitle: metaContent(html, "property", "og:title"),
    checks,
  };
}
