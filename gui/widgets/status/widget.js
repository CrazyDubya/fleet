export const meta = { title: 'Status', panel: 'dashboard', order: 10 };

const WARMTH_COLOR = { hot: 'var(--good)', warm: 'var(--warn)', cold: 'var(--muted)' };

function chip(text, color) {
  const span = document.createElement('span');
  span.className = 'chip';
  span.textContent = text;
  if (color) span.style.color = color;
  return span;
}

function renderRow(r) {
  const el = document.createElement('div');
  el.className = 'srow';

  const head = document.createElement('div');
  head.className = 'srow-head';
  const name = document.createElement('strong');
  name.textContent = r.name;
  head.appendChild(name);
  head.appendChild(chip(r.state, r.state === 'running' ? 'var(--good)' : 'var(--muted)'));
  head.appendChild(chip(r.warmth, WARMTH_COLOR[r.warmth] || 'var(--muted)'));
  el.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'srow-meta';
  const bits = [
    r.model,
    `idle ${r.idle_minutes}m`,
    `ctx ${r.context}`,
    r.dollars >= 0 ? `$${r.dollars.toFixed(2)}` : '$?',
  ];
  meta.textContent = bits.join(' · ');
  el.appendChild(meta);

  const flags = document.createElement('div');
  flags.className = 'srow-flags';
  if (r.spec_stale) flags.appendChild(chip('STALE-SPEC', 'var(--bad)'));
  if (r.miss_reason) flags.appendChild(chip(`miss: ${r.miss_reason}`, 'var(--warn)'));
  if (r.last_handoff) flags.appendChild(chip(`handoff: ${r.last_handoff}`, 'var(--muted)'));
  if (r.errors) flags.appendChild(chip(`${r.errors} err`, 'var(--bad)'));
  if (flags.children.length) el.appendChild(flags);

  return el;
}

export function mount(ctx) {
  ctx.css(`
    .srows { display: flex; flex-direction: column; gap: 8px; }
    .srow { border: 1px solid var(--border); border-radius: 8px; padding: 8px; min-width: 0; }
    .srow-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .srow-meta { color: var(--muted); font-size: 13px; margin-top: 2px; word-break: break-word; }
    .srow-flags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    .chip { font-size: 11px; border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; }
  `);
  ctx.root.innerHTML = '<div class="srows"></div>';
  const wrap = ctx.root.querySelector('.srows');

  const draw = async () => {
    let data;
    try {
      data = await ctx.api.get('');
    } catch (e) {
      wrap.textContent = `error: ${e.message || e}`;
      return;
    }
    wrap.replaceChildren(...data.rows.map(renderRow));
  };

  ctx.poll(3000, draw);
  ctx.on('changed', draw);
}
