/**
 * Post-build step for the Electrobun app (electrobun.config.ts → scripts.postBuild), run before the app is compressed.
 * Fills in the native About panel: version, author (Info.plist) and a GitHub link (Credits.rtf).
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json';

const GITHUB_URL = 'https://github.com/martykan/issue-killer';

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
if (!buildDir) throw new Error('ELECTROBUN_BUILD_DIR not set (run via electrobun build)');

for (const app of readdirSync(buildDir).filter(f => f.endsWith('.app'))) {
    const contents = join(buildDir, app, 'Contents');
    const plist = join(contents, 'Info.plist');
    const set = (key: string, value: string) => {
        // Set fails when the key doesn't exist yet; Add fails when it does.
        const res = Bun.spawnSync(['/usr/libexec/PlistBuddy', '-c', `Set :${key} ${value}`, plist]);
        if (res.exitCode !== 0) Bun.spawnSync(['/usr/libexec/PlistBuddy', '-c', `Add :${key} string ${value}`, plist]);
    };
    set('CFBundleShortVersionString', pkg.version);
    set('NSHumanReadableCopyright', `Author: ${pkg.author}`);
    // No explicit colors, so the text follows light/dark mode.
    writeFileSync(
        join(contents, 'Resources', 'Credits.rtf'),
        `{\\rtf1\\ansi{\\fonttbl\\f0\\fnil .AppleSystemUIFont;}\\pard\\qc\\f0\\fs22 {\\field{\\*\\fldinst{HYPERLINK "${GITHUB_URL}"}}{\\fldrslt ${GITHUB_URL.replace('https://', '')}}}}\n`,
    );
    console.log(`  About panel: ${app}`);
}
