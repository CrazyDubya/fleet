export const meta = { title: 'Workspace', panel: 'workspace', order: 0 };

function renderItem(ctx, item, body) {
  const el = document.createElement('div');
  el.className = 'wsitem';

  const head = document.createElement('div');
  head.className = 'wsitem-head';
  head.textContent = item.name;
  el.appendChild(head);

  const content = document.createElement('div');
  content.className = 'wsitem-body';
  if (item.format === 'html') {
    const frame = document.createElement('iframe');
    frame.sandbox = 'allow-popups';
    frame.srcdoc = body;
    frame.className = 'wsframe';
    content.appendChild(frame);
  } else {
    content.innerHTML = ctx.md(body);
  }
  el.appendChild(content);

  return el;
}

export function mount(ctx) {
  ctx.css(`
    .wscompose { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
    .wscompose input, .wscompose select, .wscompose textarea {
      background: var(--bg); color: var(--text); border: 1px solid var(--border);
      border-radius: 8px; padding: 8px; width: 100%;
    }
    .wscompose textarea { min-height: 100px; resize: vertical; }
    .wscompose .row { display: flex; gap: 6px; }
    .wscompose .row select { flex: 0 0 auto; width: auto; }
    .wscompose .row input { flex: 1; }
    .wscompose button {
      background: var(--accent); color: #06131f; border: none; border-radius: 8px;
      font-weight: 600;
    }
    .wsfeed { display: flex; flex-direction: column; gap: 10px; }
    .wsitem { border: 1px solid var(--border); border-radius: 8px; padding: 8px; min-width: 0; }
    .wsitem-head { color: var(--muted); font-size: 12px; margin-bottom: 6px; word-break: break-all; }
    .wsitem-body { min-width: 0; }
    .wsitem-body p, .wsitem-body h1, .wsitem-body h2, .wsitem-body h3 { margin: 0 0 6px; }
    .wsitem-body pre { overflow-x: auto; }
    .wsframe { width: 100%; min-height: 200px; border: none; background: #fff; border-radius: 6px; }
  `);

  ctx.root.innerHTML = `
    <div class="wscompose">
      <div class="row">
        <select class="ws-format"><option value="md">markdown</option><option value="html">html</option></select>
        <input class="ws-title" placeholder="title (optional)">
      </div>
      <textarea class="ws-body" placeholder="paste markdown or html…"></textarea>
      <button class="ws-push">Push</button>
    </div>
    <div class="wsfeed"></div>
  `;

  const feed = ctx.root.querySelector('.wsfeed');
  const bodyEl = ctx.root.querySelector('.ws-body');
  const titleEl = ctx.root.querySelector('.ws-title');
  const formatEl = ctx.root.querySelector('.ws-format');
  const pushBtn = ctx.root.querySelector('.ws-push');

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
