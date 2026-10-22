/**
 * Electrobun main process: runs the same Bun server as `bun run ui` in-process and shows it in a native window.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ApplicationMenu, BrowserWindow, PATHS, Utils } from 'electrobun/main';

// GUI apps get a minimal PATH; we need `claude`, `gh` and `git` from the user's shell setup.
function adoptLoginShellPath() {
    const shell = process.env.SHELL ?? '/bin/zsh';
    const res = Bun.spawnSync([shell, '-ilc', 'printf "%s" "$PATH"'], { stdout: 'pipe', stderr: 'ignore' });
    const path = res.stdout.toString().trim();
    if (res.exitCode === 0 && path) process.env.PATH = path;
}
adoptLoginShellPath();

// Bundled resources (see scripts/prepare-desktop.ts) and where to keep data.
const resources = join(PATHS.RESOURCES_FOLDER, 'app', 'desktop');
process.env.ISSUE_KILLER_PROMPTS = join(resources, 'prompts');
process.env.ISSUE_KILLER_MCP_SCRIPT = join(resources, 'mcp', 'investigate-tools.js');
const dataDir = process.env.ISSUE_KILLER_DATA ?? join(Utils.paths.appData, 'Issue Killer');
mkdirSync(dataDir, { recursive: true });

const { startServer } = await import('../app-server.ts');

// A fixed port keeps the UI origin stable, so localStorage (remembered team, sidebar state) survives restarts.
const PREFERRED_PORT = 47815;
const serverOptions = {
    dbPath: join(dataDir, 'issues.db'),
    repoPath: join(dataDir, 'trezor-suite'),
    ui: { staticDir: join(resources, 'ui') },
};
let server: ReturnType<typeof startServer>;
try {
    server = startServer({ ...serverOptions, port: PREFERRED_PORT });
} catch {
    server = startServer({ ...serverOptions, port: 0 });
}
console.log(`Issue Killer: data in ${dataDir}, server at ${server.url}`);
if (!existsSync(serverOptions.repoPath)) console.log(`No trezor-suite checkout at ${serverOptions.repoPath}; "Investigate" needs one.`);

const win = new BrowserWindow({
    title: 'Issue Killer',
    url: server.url.href,
    frame: { width: 1500, height: 950 },
    // Traffic lights inside our toolbar, like native apps with a unified title bar.
    titleBarStyle: 'hiddenInset',
    trafficLightOffset: { x: 12, y: 9 },
});

// Links with target=_blank (GitHub, PRs, comments) open in the default browser.
win.webview.on('new-window-open' as 'will-navigate', (event: unknown) => {
    const detail = (event as { data: { detail: string | { url: string } } }).data.detail;
    const url = typeof detail === 'string' ? detail : detail.url;
    if (/^https?:\/\//.test(url)) Utils.openExternal(url);
});

ApplicationMenu.setApplicationMenu([
    {
        // Electrobun only gives Edit roles default shortcuts; the rest need explicit accelerators.
        submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide', accelerator: 'CommandOrControl+H' },
            { role: 'hideOthers', accelerator: 'CommandOrControl+Alt+H' },
            { role: 'showAll' },
            { type: 'separator' },
            { role: 'quit', accelerator: 'CommandOrControl+Q' },
        ],
    },
    {
        label: 'Edit',
        submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
        ],
    },
    {
        label: 'View',
        submenu: [
            { label: 'Reload', action: 'reload', accelerator: 'CommandOrControl+R' },
            { label: 'Open in Browser', action: 'open-in-browser' },
            { label: 'Show Data Folder', action: 'show-data' },
        ],
    },
    {
        label: 'Window',
        submenu: [
            { role: 'minimize', accelerator: 'CommandOrControl+M' },
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'close', accelerator: 'CommandOrControl+W' },
        ],
    },
]);

ApplicationMenu.on('application-menu-clicked', (event: unknown) => {
    const action = (event as { data: { action?: string } }).data.action;
    if (action === 'reload') win.webview.loadURL(server.url.href);
    else if (action === 'open-in-browser') Utils.openExternal(server.url.href);
    else if (action === 'show-data') Utils.openPath(dataDir);
});
