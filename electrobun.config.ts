import type { ElectrobunConfig } from 'electrobun';
import pkg from './package.json';

export default {
    app: {
        name: 'Issue Killer',
        identifier: 'com.satoshilabs.issue-killer',
        version: pkg.version,
    },
    build: {
        mainProcess: 'bun',
        bun: {
            entrypoint: 'src/desktop/main.ts',
        },
        // UI, MCP tool server and prompts are pre-built by scripts/prepare-desktop.ts (preBuild).
        copy: {
            'build/desktop-resources': 'desktop',
        },
        mac: {
            bundleCEF: false,
            createDmg: false,
            icons: 'desktop/icon.iconset',
        },
    },
    runtime: {
        exitOnLastWindowClosed: true,
    },
    scripts: {
        preBuild: 'scripts/prepare-desktop.ts',
        postBuild: 'scripts/finish-desktop.ts',
    },
} satisfies ElectrobunConfig;
