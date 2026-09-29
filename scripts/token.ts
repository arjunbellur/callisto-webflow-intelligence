#!/usr/bin/env tsx
/**
 * Set or replace the Webflow token.
 *
 *   npm run token
 *
 * Prompts for a token (input hidden), verifies it against Webflow, and writes it to .env only
 * when it works. Any token already in .env is ignored so you can always paste a fresh one.
 */
import { done, ensureToken, envFile, fail } from "./lib.js";

ensureToken()
  .then(({ sites }) => {
    done(`Token works and reaches ${sites.length} site(s). Saved to ${envFile}.`);
    for (const s of sites) console.log(`  ${s.displayName}  (${s.id})`);
    console.log("\nNext: npm run setup");
  })
  .catch((err) => fail(err instanceof Error ? err.message : String(err)));
