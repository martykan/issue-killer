import type { ElectrobunConfig } from 'electrobun';

export default {
    app: {
        name: 'Issue Killer',
        identifier: 'com.satoshilabs.issue-killer',
        version: '0.1.0',
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
    },
} satisfies ElectrobunConfig;
