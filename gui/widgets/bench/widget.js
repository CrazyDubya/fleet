export const meta = { title: 'Bench', panel: 'dashboard', order: 50 };

export function mount(ctx) {
  ctx.css(`
    .bcards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
    .bcard{background:var(--panel-2,#1e2633);border-radius:12px;padding:10px}
    .bcard h3{margin:0 0 4px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
    .bval{font-size:15px}.bsub{font-size:11px;color:var(--muted)}
    .brow{display:grid;grid-template-columns:5em 4.5em 4em 5em 5em 1fr;gap:6px;font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:3px 0;border-top:1px solid #222}
    .pass{color:var(--good)}.fail,.timeout,.error{color:var(--bad)}`);
  const f = (x, d = 2) => x == null ? '–' : Number(x).toFixed(d);
  const card = (title, lines) => { const c = document.createElement('div'); c.className = 'bcard';
    const h = document.createElement('h3'); h.textContent = title; c.append(h);
    for (const [v, s] of lines) { const a = document.createElement('div'); a.className = 'bval'; a.textContent = v; const b = document.createElement('div'); b.className = 'bsub'; b.textContent = s; c.append(a, b); }
    return c; };
  const draw = async () => {
    const { summary, last } = await ctx.api.get('');
    const h = summary.headline || null; ctx.root.replaceChildren();
    if (!h) { const e = document.createElement('div'); e.className = 'bsub'; e.textContent = 'no bench runs yet'; ctx.root.append(e); return; }
    const cards = document.createElement('div'); cards.className = 'bcards';
    cards.append(
      card('accuracy', [[`fleet ${f(h.accuracy.fleet)} · sonnet ${f(h.accuracy.sonnet)} · fable ${f(h.accuracy.fable)}`, `n ${h.n.fleet}/${h.n.sonnet}/${h.n.fable}`], [`fleet/sonnet ${f(h.accuracy.fleet_vs_sonnet)}`, `fleet/fable ${f(h.accuracy.fleet_vs_fable)}`]]),
      card('cost $ per pass', [[`fleet ${f(h.cost.fleet)} · sonnet ${f(h.cost.sonnet)} · fable ${f(h.cost.fable)}`, `weekly pool: fleet ${f(h.cost.weekly.fleet)} · sonnet ${f(h.cost.weekly.sonnet)}`], [`fleet/sonnet ${f(h.cost.fleet_vs_sonnet)}`, `fleet/fable ${f(h.cost.fleet_vs_fable)}`]]),
      card('time s per pass', [[`fleet ${f(h.time.fleet, 0)} · sonnet ${f(h.time.sonnet, 0)} · fable ${f(h.time.fable, 0)}`, ''], [`fleet/sonnet ${f(h.time.fleet_vs_sonnet)}`, `fleet/fable ${f(h.time.fleet_vs_fable)}`]]));
    ctx.root.append(cards);
    for (const r of last) { const row = document.createElement('div'); row.className = 'brow ' + r.status;
      for (const v of [r.task, r.arm, r.status, `${f(r.wall_s, 0)}s`, `$${f(r.usd)}`, r.judge == null ? '' : `judge ${r.judge}`]) { const s = document.createElement('span'); s.textContent = v; row.append(s); }
      ctx.root.append(row); }
  };
  ctx.on('changed', draw); ctx.poll(30000, draw); draw();
}
