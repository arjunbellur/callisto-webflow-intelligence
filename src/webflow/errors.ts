/** Error raised for any non-2xx response from the Webflow Data API. */
export class WebflowApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(`Webflow API ${method} ${path} failed (${status}${code ? ` ${code}` : ""}): ${message}`);
    this.name = "WebflowApiError";
  }

  /** True when retrying the same request later may succeed. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** Parses Webflow's error envelope ({ code, message, details }) defensively. */
export async function toApiError(res: Response, method: string, path: string): Promise<WebflowApiError> {
  let body: unknown;
  const text = await res.text().catch(() => "");
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  const envelope = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const message =
    typeof envelope.message === "string" ? envelope.message : typeof body === "string" && body ? body : res.statusText;
  const code = typeof envelope.code === "string" ? envelope.code : undefined;
  return new WebflowApiError(res.status, method, path, message, code, envelope.details);
}
