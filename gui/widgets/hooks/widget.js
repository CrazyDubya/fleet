export const meta = { title: 'Hooks', panel: 'dashboard', order: 40 };

export function mount(ctx) {
  ctx.css(`
    .hrow{display:grid;grid-template-columns:3.5em 5em 6em 7em 1fr;gap:6px;font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:3px 0;border-top:1px solid #222}
    .hrow.bad{color:var(--bad)}.hrow.warn{color:var(--warn)}
    .counts{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px;font-size:12px;color:var(--muted)}`);
  const age = t => { const s = Math.round(Date.now() / 1000 - t); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h'; };
  const draw = async () => {
    const { events, counts } = await ctx.api.get('?n=40');
    ctx.root.replaceChildren();
    const c = document.createElement('div'); c.className = 'counts';
    for (const [t, d] of Object.entries(counts)) { const s = document.createElement('span'); s.textContent = `${t}: ` + Object.entries(d).map(([k, v]) => `${k} ${v}`).join(' · '); c.append(s); }
    ctx.root.append(c);
    for (const e of events) {
      const r = document.createElement('div');
      const old = e.decision === 'escalate' && (Date.now() / 1000 - e.t) > 60;
      r.className = 'hrow' + (e.decision === 'block' || old ? ' bad' : e.decision === 'escalate' || e.decision === 'deny' ? ' warn' : '');
      for (const v of [age(e.t), e.hook, e.thread, e.decision, e.why || '']) { const s = document.createElement('span'); s.textContent = v; r.append(s); }
      ctx.root.append(r);
    }
  };
  ctx.on('changed', draw); ctx.poll(10000, draw); draw();
}
