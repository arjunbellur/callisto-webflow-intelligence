import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const ALIAS = /^[a-z0-9][a-z0-9-]*$/;
const OBJECT_ID = /^[0-9a-f]{24}$/;

export const ClientSchema = z.object({
  alias: z.string().regex(ALIAS, "alias must be lowercase letters, digits and dashes"),
  name: z.string().min(1),
  siteId: z.string().regex(OBJECT_ID, "siteId must be a 24-character Webflow ObjectId"),
  /** Name of the environment variable that holds this client's Webflow token. */
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  /** Public production URL used by verify_live for relative paths. */
  liveUrl: z.url().optional(),
  /** When true, every write tool refuses to apply changes for this client. */
  readOnly: z.boolean().default(false),
  notes: z.string().optional(),
});

export const RegistrySchema = z
  .object({ clients: z.array(ClientSchema).min(1) })
  .superRefine((reg, ctx) => {
    const seen = new Set<string>();
    for (const [i, c] of reg.clients.entries()) {
      if (seen.has(c.alias)) {
        ctx.addIssue({ code: "custom", path: ["clients", i, "alias"], message: `duplicate alias "${c.alias}"` });
      }
      seen.add(c.alias);
    }
  });

export type ClientConfig = z.infer<typeof ClientSchema>;
export type Registry = z.infer<typeof RegistrySchema>;

export interface AppConfig {
  registry: Registry;
  registryPath: string;
  dataDir: string;
  defaultTokenEnv: string;
  env: NodeJS.ProcessEnv;
}

/** Parses and validates a registry document, producing readable errors. */
export function parseRegistry(raw: unknown, source = "clients registry"): Registry {
  const result = RegistrySchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid ${source}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Loads configuration from the environment (and a local .env file when present). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const envFile = path.resolve(cwd, ".env");
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);

  const registryPath = path.resolve(cwd, env.CALLISTO_CLIENTS_FILE ?? "clients.json");
  if (!existsSync(registryPath)) {
    throw new Error(
      `Client registry not found at ${registryPath}. Copy clients.example.json to clients.json or set CALLISTO_CLIENTS_FILE.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse ${registryPath}: ${(err as Error).message}`);
  }

  return {
    registry: parseRegistry(raw, registryPath),
    registryPath,
    dataDir: path.resolve(cwd, env.CALLISTO_DATA_DIR ?? ".callisto"),
    defaultTokenEnv: env.CALLISTO_DEFAULT_TOKEN_ENV ?? "WEBFLOW_API_TOKEN",
    env,
  };
}
