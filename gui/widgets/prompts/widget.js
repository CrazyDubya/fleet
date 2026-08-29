export const meta = { title: 'Prompts', panel: 'dashboard', order: 5 };

export function mount(ctx) {
  ctx.css(`
    .pcard{border:1px solid var(--bad);border-radius:12px;padding:10px;margin:8px 0}
    .pcmd{font-family:ui-monospace,Menlo,monospace;font-size:13px;white-space:pre-wrap;word-break:break-all;margin:6px 0}
    .pane{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);white-space:pre-wrap;max-height:9em;overflow:auto;margin:6px 0}
    .row{display:flex;gap:8px;flex-wrap:wrap}
    .btn{min-height:44px;min-width:44px;padding:0 16px;border-radius:10px;border:0;font-weight:600;font-size:15px}
    .ok{background:var(--good);color:#001}.no{background:var(--bad);color:#fff}.key{background:var(--panel-2,#2a3140);color:var(--text)}
    .empty{color:var(--muted);padding:8px}`);
  const root = ctx.root;
  const btn = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = label; b.onclick = fn; return b; };
  const draw = async () => {
    const { items } = await ctx.api.get('');
    root.replaceChildren();
    if (!items.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'no pending prompts'; root.append(e); return; }
    for (const it of items) {
      const c = document.createElement('div'); c.className = 'pcard';
      const h = document.createElement('div'); const strong = document.createElement('strong'); strong.textContent = it.thread; h.append(strong, document.createTextNode(` · ${String(it.tool)} · ${Math.round(Date.now() / 1000 - it.t)}s ago`));
      const cmd = document.createElement('div'); cmd.className = 'pcmd'; cmd.textContent = it.command;
      const pane = document.createElement('div'); pane.className = 'pane'; pane.textContent = it.pane.join('\n');
      const row = document.createElement('div'); row.className = 'row';
      row.append(btn('Proceed', 'ok', () => ctx.api.post('decide', { thread: it.thread, id: it.id, decision: 'allow' }).then(draw)),
                 btn('Deny', 'no', () => ctx.api.post('decide', { thread: it.thread, id: it.id, decision: 'deny' }).then(draw)));
      for (const k of ['1', '2', 'Enter', 'Escape']) row.append(btn(k, 'key', () => ctx.api.post('keypress', { thread: it.thread, key: k }).then(() => ctx.toast(`sent ${k} to ${it.thread}`))));
      c.append(h, cmd, pane, row); root.append(c);
    }
  };
  ctx.on('changed', draw); ctx.poll(3000, draw); draw();
}
