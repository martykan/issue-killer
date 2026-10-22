import { parseArgs } from 'node:util';
import { startServer } from './app-server.ts';
import { DEFAULT_DB_PATH } from './db.ts';
import { DEFAULT_REPO_PATH } from './investigate.ts';
import index from './ui/index.html';

const { values } = parseArgs({
    options: {
        db: { type: 'string', default: DEFAULT_DB_PATH },
        port: { type: 'string', default: process.env.PORT ?? '3000' },
        repo: { type: 'string' },
        'repo-path': { type: 'string', default: DEFAULT_REPO_PATH },
    },
});

const server = startServer({
    dbPath: values.db,
    repoPath: values['repo-path'],
    port: Number(values.port),
    repo: values.repo,
    ui: { html: index },
    development: process.env.NODE_ENV !== 'production',
});

console.log(`Issue browser running at ${server.url}`);
