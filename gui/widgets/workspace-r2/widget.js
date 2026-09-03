export const meta = { title: 'Workspace R2', panel: 'workspace', order: 1 };

function renderItem(ctx, item, body) {
  const el = document.createElement('div');
  el.className = 'wr2item';

  const head = document.createElement('div');
  head.className = 'wr2item-head';
  head.textContent = item.name;
  el.appendChild(head);

  const content = document.createElement('div');
  content.className = 'wr2item-body';
  if (item.format === 'html') {
    const frame = document.createElement('iframe');
    frame.sandbox = 'allow-popups';
    frame.srcdoc = body;
    frame.className = 'wr2frame';
    content.appendChild(frame);
  } else {
    content.innerHTML = ctx.md(body);
  }
  el.appendChild(content);

  return el;
}

export function mount(ctx) {
  ctx.css(`
    .wr2compose { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
    .wr2compose input, .wr2compose select, .wr2compose textarea {
      background: var(--bg); color: var(--text); border: 1px solid var(--border);
      border-radius: 8px; padding: 8px; width: 100%;
    }
    .wr2compose textarea { min-height: 100px; resize: vertical; }
    .wr2compose .row { display: flex; gap: 6px; }
    .wr2compose .row select { flex: 0 0 auto; width: auto; }
    .wr2compose .row input { flex: 1; }
    .wr2compose button {
      background: var(--accent); color: #06131f; border: none; border-radius: 8px;
      font-weight: 600;
    }
    .wr2feed { display: flex; flex-direction: column; gap: 10px; }
    .wr2item { border: 1px solid var(--border); border-radius: 8px; padding: 8px; min-width: 0; }
    .wr2item-head { color: var(--muted); font-size: 12px; margin-bottom: 6px; word-break: break-all; }
    .wr2item-body { min-width: 0; }
    .wr2item-body p, .wr2item-body h1, .wr2item-body h2, .wr2item-body h3 { margin: 0 0 6px; }
    .wr2item-body pre { overflow-x: auto; }
    .wr2frame { width: 100%; min-height: 200px; border: none; background: #fff; border-radius: 6px; }
  `);

  ctx.root.innerHTML = `
    <div class="wr2compose">
      <div class="row">
        <select class="wr2-format"><option value="md">markdown</option><option value="html">html</option></select>
        <input class="wr2-title" placeholder="title (optional)">
      </div>
      <textarea class="wr2-body" placeholder="paste markdown or html…"></textarea>
      <button class="wr2-push">Push</button>
    </div>
    <div class="wr2feed"></div>
  `;

  const feed = ctx.root.querySelector('.wr2feed');
  const bodyEl = ctx.root.querySelector('.wr2-body');
  const titleEl = ctx.root.querySelector('.wr2-title');
  const formatEl = ctx.root.querySelector('.wr2-format');
  const pushBtn = ctx.root.querySelector('.wr2-push');

  pushBtn.addEventListener('click', async () => {
    const text = bodyEl.value.trim();
    if (!text) return;
    try {
      await ctx.api.post('push', { title: titleEl.value.trim(), format: formatEl.value, body: text });
      bodyEl.value = '';
      titleEl.value = '';
      ctx.toast('pushed');
      draw();
    } catch (e) {
      ctx.toast(`push failed: ${e.message || e}`);
    }
  });

  const draw = async () => {
    let list;
    try {
      list = await ctx.api.get('');
    } catch (e) {
      feed.textContent = `error: ${e.message || e}`;
      return;
    }
    const items = await Promise.all(
      list.items.slice(0, 20).map(async item => {
        try {
          const full = await ctx.api.get(`read?p=${encodeURIComponent(item.name)}`);
          return renderItem(ctx, item, full.body);
        } catch {
          return null;
        }
      })
    );
    feed.replaceChildren(...items.filter(Boolean));
  };

  ctx.on('changed', draw);
  draw();
}
