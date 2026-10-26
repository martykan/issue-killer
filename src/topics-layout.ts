// Mind-map layout of a topic map, shared by the Topics view and its HTML export.

// Geometry (px).
const ROW = 54;
const TOPIC_GAP = 22;
export const ROOT_W = 170;
export const TOPIC_W = 240;
export const SUB_W = 250;
const X_TOPIC = 260; // root center → topic center
const X_SUB = 580; // root center → subtopic center
const MARGIN = 24;
// Categorical slots 1–8 (validated palette, fixed order); topics beyond 8 fall back to neutral.
const SLOTS = 8;

type Node = { id: number; children: Node[] };
export type Placed<T extends Node> = { node: T; x: number; y: number; side: -1 | 1; slot: number; parent?: Placed<T> };

export function layout<T extends Node>(topics: T[]) {
    const rows = (t: T) => Math.max(1, t.children.length);
    const sides: { items: T[]; rows: number }[] = [
        { items: [], rows: 0 },
        { items: [], rows: 0 },
    ];
    // Biggest topics first, each to the side with fewer rows → balanced map.
    for (const t of topics) {
        const side = sides[0]!.rows <= sides[1]!.rows ? sides[0]! : sides[1]!;
        side.items.push(t);
        side.rows += rows(t);
    }
    const sideHeight = (s: { items: T[]; rows: number }) => s.rows * ROW + Math.max(0, s.items.length - 1) * TOPIC_GAP;
    const height = Math.max(sideHeight(sides[0]!), sideHeight(sides[1]!), ROW) + 2 * MARGIN;
    const width = 2 * (X_SUB + SUB_W / 2) + 2 * MARGIN;
    const cx = width / 2;
    const placed: Placed<T>[] = [];
    sides.forEach((s, si) => {
        const dir = si === 0 ? 1 : -1;
        let y = (height - sideHeight(s)) / 2;
        for (const t of s.items) {
            const block = rows(t) * ROW;
            const slot = topics.indexOf(t);
            const topic: Placed<T> = { node: t, x: cx + dir * X_TOPIC, y: y + block / 2, side: dir as 1 | -1, slot };
            placed.push(topic);
            (t.children as T[]).forEach((c, j) => placed.push({ node: c, x: cx + dir * X_SUB, y: y + ROW * (j + 0.5), side: dir as 1 | -1, slot, parent: topic }));
            y += block + TOPIC_GAP;
        }
    });
    return { width, height, cx, cy: height / 2, placed };
}

/** Bezier from the parent (or the root) to a placed node. */
export function linkPath<T extends Node>(p: Placed<T>, root: { cx: number; cy: number }) {
    const from = p.parent ?? { x: root.cx, y: root.cy };
    const fromW = p.parent ? TOPIC_W : ROOT_W;
    const toW = p.parent ? SUB_W : TOPIC_W;
    const x1 = from.x + (p.side * fromW) / 2;
    const x2 = p.x - (p.side * toW) / 2;
    const mid = (x1 + x2) / 2;
    return `M${x1},${from.y} C${mid},${from.y} ${mid},${p.y} ${x2},${p.y}`;
}

export const slotVar = (slot: number) => (slot < SLOTS ? `var(--cat-${slot + 1})` : 'var(--muted)');
