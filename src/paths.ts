import { join } from 'node:path';

// Locations of files the code reads at runtime. Defaults point into the repo; the desktop app (where sources are
// bundled) overrides them with its Resources folder via env vars.

export const promptPath = (name: string) => join(process.env.ISSUE_KILLER_PROMPTS ?? join(import.meta.dir, '../prompts'), name);

/** Script run as the investigation agent's MCP server (by the current Bun executable). */
export const investigateMcpScript = () => process.env.ISSUE_KILLER_MCP_SCRIPT ?? join(import.meta.dir, 'mcp/investigate-tools.ts');
