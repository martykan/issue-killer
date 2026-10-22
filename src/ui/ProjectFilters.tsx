import type { UpdateParams } from './App.tsx';
import type { Meta } from './types.ts';

export const NO_VALUE = '__none';

/** Selects for the custom fields of synced GitHub Projects (pf=Field=Value). */
export function ProjectFilters({
    meta,
    params,
    update,
    exclude = [],
}: {
    meta: Meta | null;
    params: URLSearchParams;
    update: UpdateParams;
    /** Fields handled elsewhere (e.g. Team in the top bar). */
    exclude?: string[];
}) {
    if (!meta?.projects.length) return null;
    const current = (field: string) => params.getAll('pf').find(v => v.startsWith(`${field}=`))?.slice(field.length + 1) ?? '';
    const set = (field: string, value: string) =>
        update(p => {
            const others = p.getAll('pf').filter(v => !v.startsWith(`${field}=`));
            p.delete('pf');
            for (const v of others) p.append('pf', v);
            if (value) p.append('pf', `${field}=${value}`);
        });

    return (
        <div className="select-grid">
            {meta.projects.flatMap(project =>
                project.fields
                    .filter(f => !exclude.includes(f.name))
                    .map(f => (
                        <label key={`${project.number}-${f.name}`} className="field-select">
                            <span className="field-label">{f.name}</span>
                            <select value={current(f.name)} onChange={e => set(f.name, e.target.value)}>
                                <option value="">Any</option>
                                {f.options.map(o => (
                                    <option key={o.value} value={o.value}>
                                        {o.value} ({o.count})
                                    </option>
                                ))}
                                <option value={NO_VALUE}>Not set</option>
                            </select>
                        </label>
                    )),
            )}
        </div>
    );
}
