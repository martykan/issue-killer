/**
 * Installs the stable build into ~/Applications (Spotlight / Launchpad / Dock-friendly) and launches it once,
 * which lets Electrobun's self-extractor unpack it in place. Run after `bun run desktop:build`.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = 'Issue Killer.app';
const source = join(import.meta.dir, '..', 'build/stable-macos-arm64', APP);
const targetDir = join(homedir(), 'Applications');
const target = join(targetDir, APP);

if (!existsSync(source)) throw new Error(`No build at ${source}; run \`bun run desktop:build\` first.`);

// Quit a running copy so it can be replaced (no-op if it isn't running).
Bun.spawnSync(['osascript', '-e', 'tell application id "com.satoshilabs.issue-killer" to quit']);
await Bun.sleep(1000);

mkdirSync(targetDir, { recursive: true });
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true, verbatimSymlinks: true });
console.log(`Installed ${target}`);

Bun.spawnSync(['open', target]);
console.log('Launched. From now on start it from Spotlight, Launchpad or ~/Applications.');
