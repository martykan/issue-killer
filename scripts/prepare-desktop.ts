/**
 * Pre-build step for the Electrobun app (electrobun.config.ts → scripts.preBuild).
 * Bundles what the main process loads at runtime into build/desktop-resources, which is copied into the app:
 *   ui/      the React UI (served by the in-app Bun server)
 *   mcp/     the investigation agent's MCP tool server as a single file (no node_modules in the app)
 *   prompts/ Claude prompts
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const out = join(root, 'build/desktop-resources');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const check = (name: string, result: Awaited<ReturnType<typeof Bun.build>>) => {
    if (!result.success) {
        for (const log of result.logs) console.error(log);
        throw new Error(`${name} build failed`);
    }
    console.log(`  ${name}: ${result.outputs.length} files`);
};

check(
    'ui',
    await Bun.build({
        entrypoints: [join(root, 'src/ui/index.html')],
        outdir: join(out, 'ui'),
        minify: true,
        target: 'browser',
        define: { 'process.env.NODE_ENV': '"production"' },
    }),
);
check(
    'mcp',
    await Bun.build({
        entrypoints: [join(root, 'src/mcp/investigate-tools.ts')],
        outdir: join(out, 'mcp'),
        target: 'bun',
        naming: 'investigate-tools.js',
    }),
);
cpSync(join(root, 'prompts'), join(out, 'prompts'), { recursive: true });
console.log(`  prompts copied → ${out}`);
