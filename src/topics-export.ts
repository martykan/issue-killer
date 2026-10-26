import type { getTopicMap, TopicNode } from './topics.ts';
import { layout, linkPath, ROOT_W, SUB_W, slotVar, TOPIC_W } from './topics-layout.ts';

// Topics view → one self-contained HTML file (mind map + outline with linked issues) to share outside the app.

type TopicMap = NonNullable<ReturnType<typeof getTopicMap>>;

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const scopeLabel = (scope: string) => (scope === 'all' ? 'All open issues' : scope.slice(5));

function flags(node: TopicNode) {
    const dupes = node.children.length ? node.children.reduce((n, c) => n + c.duplicateGroups.length, 0) : node.duplicateGroups.length;
    return [
        node.high > 0 && `<span class="flag flag-high">${node.high} HIGH</span>`,
        node.closeCandidates > 0 && `<span class="flag flag-close">${node.closeCandidates} close?</span>`,
        dupes > 0 && `<span class="flag flag-dup">${dupes} dup</span>`,
    ]
        .filter(Boolean)
        .join('');
}

function mindMap(map: TopicMap) {
    const g = layout(map.topics);
    const links = g.placed
        .map(p => `<path d="${linkPath(p, g)}" stroke="${slotVar(p.slot)}" stroke-opacity="0.55" stroke-width="${p.parent ? 1.5 : 2}" fill="none"/>`)
        .join('');
    const nodes = g.placed
        .map(p => {
            const isTopic = !p.parent;
            const w = isTopic ? TOPIC_W : SUB_W;
            const f = flags(p.node);
            return `<a href="#topic-${p.node.id}" class="mm-node ${isTopic ? 'mm-topic' : 'mm-sub'}" title="${esc(p.node.description)}" style="left:${p.x - w / 2}px;top:${p.y}px;width:${w}px;--topic:${slotVar(p.slot)}"><span class="mm-name">${esc(p.node.name)}</span><span class="mm-count">${p.node.count}</span>${f ? `<span class="mm-flags">${f}</span>` : ''}</a>`;
        })
        .join('');
    const root = `<div class="mm-node mm-root" style="left:${g.cx - ROOT_W / 2}px;top:${g.cy}px;width:${ROOT_W}px"><div class="mm-name">${esc(scopeLabel(map.scope))}</div><div class="mm-stats">${map.topics.reduce((n, t) => n + t.count, 0)} issues</div></div>`;
    // Laid out at full size and scaled down to the page width by FIT_SCRIPT, like the app does.
    return `<div class="mindmap-fit"><div class="mindmap" data-width="${g.width}" data-height="${g.height}" style="width:${g.width}px;height:${g.height}px"><svg width="${g.width}" height="${g.height}" aria-hidden="true">${links}</svg>${root}${nodes}</div></div>`;
}

function outline(map: TopicMap, repo: string | null) {
    const issueUrl = (n: number) => (repo ? `https://github.com/${repo}/issues/${n}` : '#');
    return map.topics
        .map((t, i) => {
            const subs = t.children
                .map(s => {
                    const byNumber = new Map(s.issues.map(x => [x.number, x]));
                    const dupes = s.duplicateGroups
                        .map(grp => `<div class="dup-group">${grp.map(n => `<a href="${issueUrl(n)}">#${n} ${esc(byNumber.get(n)?.title ?? '')}</a>`).join('')}</div>`)
                        .join('');
                    const issues = s.issues
                        .map(
                            x =>
                                `<li><a href="${issueUrl(x.number)}">#${x.number} ${esc(x.title)}</a><span class="issue-flags">${[
                                    x.priority && /high/i.test(x.priority) && '<span class="flag flag-high">HIGH</span>',
                                    x.closeCandidate && '<span class="flag flag-close">close?</span>',
                                    x.stale && '<span class="flag">stale</span>',
                                ]
                                    .filter(Boolean)
                                    .join('')}</span></li>`,
                        )
                        .join('');
                    return `<section class="sub" id="topic-${s.id}"><h3>${esc(s.name)} <span class="muted">${s.count}</span> ${flags(s)}</h3><p class="muted">${esc(s.description)}</p>${dupes ? `<h4>Likely duplicates</h4>${dupes}` : ''}<ul class="issues">${issues}</ul></section>`;
                })
                .join('');
            return `<details open class="topic" id="topic-${t.id}" style="--topic:${slotVar(i)}"><summary><h2>${esc(t.name)} <span class="muted">${t.count}</span> ${flags(t)}</h2></summary><p class="muted">${esc(t.description)}</p>${subs}</details>`;
        })
        .join('');
}

export function renderTopicsHtml(map: TopicMap, repo: string | null) {
    const title = `Topics: ${scopeLabel(map.scope)}${repo ? ` · ${repo}` : ''}`;
    const generated = new Date(map.generatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    const summary = [`${map.topics.length} topics`, `${map.topics.reduce((n, t) => n + t.count, 0)} issues`, `generated ${generated} by ${map.model}`]
        .filter(Boolean)
        .join(' · ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header><h1>${esc(title)}</h1><p class="muted">${esc(summary)}</p>
<p class="muted small">Badges: <span class="flag flag-high">HIGH</span> high-priority issues, <span class="flag flag-close">close?</span> issues triage or the agent suggest closing, <span class="flag flag-dup">dup</span> groups of likely duplicates.</p></header>
<div class="map-wrap">${mindMap(map)}</div>
<main>${outline(map, repo)}</main>
<script>${FIT_SCRIPT}</script>
</body>
</html>
`;
}

// Scales the mind map to the available width (never up); without script the map scrolls horizontally instead.
const FIT_SCRIPT = `
const fit = () => {
    const map = document.querySelector('.mindmap');
    const box = map.parentElement;
    const w = Number(map.dataset.width), h = Number(map.dataset.height);
    const scale = Math.min(1, box.parentElement.clientWidth / w);
    map.style.transform = 'scale(' + scale + ')';
    box.style.width = w * scale + 'px';
    box.style.height = h * scale + 'px';
};
fit();
addEventListener('resize', fit);
matchMedia('print').addEventListener('change', fit);
`;

// Subset of the app's styles (src/ui/styles.css) the export needs.
const CSS = `
:root {
    --bg: #fff; --bg-subtle: #f5f5f7; --border: rgb(0 0 0 / 0.1); --text: rgb(0 0 0 / 0.85); --muted: rgb(0 0 0 / 0.5);
    --accent: #007aff; --danger: #ff3b30; --dup: #9a6700;
    --cat-1: #2a78d6; --cat-2: #eb6834; --cat-3: #1baf7a; --cat-4: #eda100; --cat-5: #e87ba4; --cat-6: #008300; --cat-7: #4a3aa7; --cat-8: #e34948;
    color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
    :root {
        --bg: #1e1e1e; --bg-subtle: #262626; --border: rgb(255 255 255 / 0.1); --text: rgb(255 255 255 / 0.88); --muted: rgb(255 255 255 / 0.55);
        --accent: #0a84ff; --danger: #ff453a; --dup: #d4a72c;
        --cat-1: #3987e5; --cat-2: #d95926; --cat-3: #199e70; --cat-4: #c98500; --cat-5: #d55181; --cat-6: #008300; --cat-7: #9085e9; --cat-8: #e66767;
    }
}
body { margin: 0; padding: 24px 32px 48px; font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--text); background: var(--bg); }
a { color: inherit; }
h1 { margin: 0 0 4px; font-size: 22px; }
header p { margin: 2px 0; }
.muted { color: var(--muted); font-weight: 400; }
.small { font-size: 12px; }
.map-wrap { overflow-x: auto; margin: 16px 0 24px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.mindmap-fit { margin: 0 auto; }
.mindmap { position: relative; transform-origin: top left; }
.mindmap svg { position: absolute; inset: 0; }
.mm-node { position: absolute; translate: 0 -50%; box-sizing: border-box; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; padding: 5px 10px; border-radius: 8px; font-size: 12px; color: var(--text); background: var(--bg); border: 1px solid var(--border); text-decoration: none; }
.mm-root { flex-direction: column; align-items: center; padding: 6px 10px; background: var(--bg-subtle); border: 1.5px solid var(--text); font-weight: 600; }
.mm-topic { font-size: 13px; font-weight: 600; min-height: 40px; background: color-mix(in srgb, var(--topic) 16%, var(--bg)); border: 1.5px solid var(--topic); }
.mm-sub { min-height: 32px; border-left: 3px solid var(--topic); }
a.mm-node:hover { box-shadow: 0 0 0 2px var(--topic); }
.mm-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mm-count { font-variant-numeric: tabular-nums; color: var(--muted); font-weight: 600; }
.mm-stats { font-size: 11px; font-weight: 400; color: var(--muted); }
.mm-flags { flex-basis: 100%; display: flex; gap: 4px; }
.flag { display: inline-block; font-size: 10px; font-weight: 400; padding: 0 5px; border-radius: 6px; line-height: 15px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; vertical-align: middle; }
.flag-high { color: var(--danger); border-color: currentColor; }
.flag-close { color: var(--accent); border-color: currentColor; }
.flag-dup { color: var(--dup); border-color: currentColor; }
main { max-width: 900px; }
.topic { margin: 0 0 20px; }
.topic summary { cursor: pointer; }
.topic summary h2 { display: inline; margin: 0; font-size: 17px; border-left: 4px solid var(--topic); padding-left: 8px; }
.topic > p { margin: 4px 0 10px 12px; }
.sub { margin: 0 0 14px 12px; padding-left: 12px; border-left: 2px solid color-mix(in srgb, var(--topic) 40%, transparent); }
.sub h3 { margin: 10px 0 2px; font-size: 14px; }
.sub p { margin: 0 0 6px; }
h4 { margin: 10px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.dup-group { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; margin-bottom: 6px; border-radius: 6px; border: 1px dashed var(--dup); }
.issues { list-style: none; margin: 0; padding: 0; }
.issues li { display: flex; gap: 6px; align-items: baseline; padding: 3px 0; border-bottom: 1px solid var(--border); }
.issues a { text-decoration: none; }
.issues a:hover, .dup-group a:hover { text-decoration: underline; }
.dup-group a { text-decoration: none; }
.issue-flags { margin-left: auto; display: flex; gap: 3px; }
@media print { .map-wrap { break-after: page; } }
`;
