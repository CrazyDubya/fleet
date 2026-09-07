export const meta = { title: 'Decisions', panel: 'dashboard', order: 3 };

export function mount(ctx) {
  ctx.css(`
    .dcard{border:1px solid var(--warn,#c90);border-radius:12px;padding:10px;margin:8px 0}
    .dtitle{font-weight:700;font-size:15px;margin-bottom:4px}
    .dfield{margin:6px 0}
    .dlabel{font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.03em}
    .dtext{white-space:pre-wrap;font-size:14px}
    .dreply{font-family:ui-monospace,Menlo,monospace;background:var(--panel-2,#2a3140);padding:6px 8px;border-radius:8px;display:inline-block;margin-top:4px}
    .dlinks{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
    .dlink{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--panel-2,#2a3140);border:0;border-radius:8px;padding:4px 8px;cursor:pointer;color:var(--text)}
    .dlink.plain{cursor:default;opacity:.6}
    .dcontent{white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:12px;max-height:16em;overflow:auto;background:var(--panel-2,#2a3140);border-radius:8px;padding:8px;margin-top:6px}
    .empty{color:var(--muted);padding:8px}
    .note{color:var(--muted);font-size:13px;padding:4px 0}
    .err{color:var(--bad);padding:8px}
    .watchdog{border:2px solid var(--bad);border-radius:12px;padding:12px;margin:0 0 12px;background:var(--panel-2,#2a3140);font-weight:600}
    .watchdog .wlabel{text-transform:uppercase;letter-spacing:.04em;font-size:11px;color:var(--bad);margin-bottom:4px}
    .watchdog .wtext{font-family:ui-monospace,Menlo,monospace;font-weight:400;white-space:pre-wrap}`);
  const root = ctx.root;

  const field = (label, text) => {
    if (!text) return null;
    const f = document.createElement('div'); f.className = 'dfield';
    const l = document.createElement('div'); l.className = 'dlabel'; l.textContent = label;
    const t = document.createElement('div'); t.className = 'dtext'; t.textContent = text;
    f.append(l, t); return f;
  };

  const linksRow = (links) => {
    const row = document.createElement('div'); row.className = 'dlinks';
    for (const link of links) {
      const b = document.createElement('button');
      b.className = 'dlink' + (link.rel ? '' : ' plain');
      b.textContent = link.rel ? link.path.split('/').pop() : link.path + ' (not linkable)';
      if (!link.rel) { b.disabled = true; row.append(b); continue; }
      const pane = document.createElement('div'); pane.className = 'dcontent'; pane.hidden = true;
      b.onclick = async () => {
        if (!pane.hidden) { pane.hidden = true; return; }
        if (!pane.textContent) {
          const { text, truncated } = await ctx.api.get('handoff?path=' + encodeURIComponent(link.rel));
          pane.textContent = text + (truncated ? '\n\n… truncated …' : '');
        }
        pane.hidden = false;
      };
      const wrap = document.createElement('div');
      wrap.append(b, pane);
      row.append(wrap);
    }
    return row;
  };

  const decisionCard = (d) => {
    const c = document.createElement('div'); c.className = 'dcard';
    const h = document.createElement('div'); h.className = 'dtitle'; h.textContent = `${d.n}. ${d.title}`;
    c.append(h);
    for (const [label, text] of [['What', d.what], ['Options', d.options], ['Recommendation', d.recommendation]]) {
      const f = field(label, text); if (f) c.append(f);
    }
    if (d.reply_with) {
      const f = document.createElement('div'); f.className = 'dfield';
      const l = document.createElement('div'); l.className = 'dlabel'; l.textContent = 'Reply with';
      const t = document.createElement('div'); t.className = 'dreply'; t.textContent = d.reply_with;
      f.append(l, t); c.append(f);
    }
    if (d.links && d.links.length) c.append(linksRow(d.links));
    return c;
  };

  const openRowCard = (row) => {
    const c = document.createElement('div'); c.className = 'dcard';
    const h = document.createElement('div'); h.className = 'dtitle'; h.textContent = `${row.id} — ${row.expects}`;
    c.append(h);
    const f = field('Notes', row.notes); if (f) c.append(f);
    if (row.links && row.links.length) c.append(linksRow(row.links));
    return c;
  };

  const statusNote = (label, status, path) => {
    const n = document.createElement('div'); n.className = status === 'unreadable' || status === 'missing' ? 'err' : 'note';
    n.textContent = `${label}: ${status}${path ? ' (' + path + ')' : ''}`;
    return n;
  };

  const draw = async () => {
    let data;
    try {
      data = await ctx.api.get('');
    } catch (e) {
      root.replaceChildren();
      const err = document.createElement('div'); err.className = 'err';
      err.textContent = 'failed to load decisions: ' + e;
      root.append(err);
      return;
    }
    root.replaceChildren();
    // Prominent, above everything else: this is the piece meant to make a
    // silent, stalled fleet reach the operator instead of sitting
    // invisible on this machine. Read-only - just renders whatever the
    // watchdog job itself already wrote; nothing here can clear it.
    if (data.watchdog_alert) {
      const w = document.createElement('div'); w.className = 'watchdog';
      const l = document.createElement('div'); l.className = 'wlabel'; l.textContent = 'Watchdog alert';
      const t = document.createElement('div'); t.className = 'wtext'; t.textContent = data.watchdog_alert;
      w.append(l, t); root.append(w);
    }
    // Distinct states, never collapsed into a bare empty list: "answered"
    // and "no rows" are real assertions; "missing"/"unreadable" are not -
    // this must not read the same as "nothing pending" (spec's own rule).
    if (data.decisions_status !== 'pending') {
      root.append(statusNote('DECISIONS.md', data.decisions_status, data.decisions_path));
      if (data.decisions_resolved_note) {
        const n = document.createElement('div'); n.className = 'note'; n.textContent = data.decisions_resolved_note;
        root.append(n);
      }
    }
    if (data.open_status !== 'ok') {
      root.append(statusNote('OPEN.md', data.open_status, data.open_path));
    }
    if (data.pending_count === 0 && data.decisions_status !== 'missing' && data.decisions_status !== 'unreadable'
        && data.open_status !== 'missing' && data.open_status !== 'unreadable') {
      const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'no decisions pending';
      root.append(e);
      return;
    }
    for (const d of data.decisions) root.append(decisionCard(d));
    for (const row of data.open_rows) root.append(openRowCard(row));
  };

  ctx.on('changed', draw); ctx.poll(15000, draw); draw();
}
