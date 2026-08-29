import { md as renderMd } from './md.js';

const panelsEl = document.getElementById('panels');
const tabbarEl = document.getElementById('tabbar');
const toastEl = document.getElementById('toast');
const PANEL_ORDER = ['dashboard', 'workspace', 'game'];

let es;
function connectSSE() {
  es = new EventSource('/api/events');
  es.addEventListener('core:reload', () => location.reload());
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 2500);
}

async function _fetch(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) {
    let message;
    try { message = (await res.json()).error; } catch { message = res.statusText; }
    throw { status: res.status, message };
  }
  const ct = res.headers.get('Content-Type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

function makeCtx(id, root) {
  const listeners = [];
  const stops = [];
  return {
    id, root,
    api: {
      get: sub => _fetch(`/w/${id}/${sub}`),
      post: (sub, body) => _fetch(`/w/${id}/${sub}`, { method: 'POST', body: JSON.stringify(body) }),
    },
    on(name, fn) {
      const type = `w:${id}:${name}`;
      const handler = e => fn(e.data ? JSON.parse(e.data) : null);
      es.addEventListener(type, handler);
      listeners.push([type, handler]);
    },
    poll(ms, fn) {
      let timer = null;
      const tick = () => { if (document.visibilityState === 'visible') fn(); };
      const start = () => { if (!timer) { tick(); timer = setInterval(tick, ms); } };
      const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
      document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? start() : stop()));
      start();
      stops.push(stop);
    },
    css(text) {
      const style = document.createElement('style');
      style.textContent = text.replace(/(^|\})\s*([^{}]+)\{/g, (m, brace, sel) => `${brace} [data-w="${id}"] ${sel.trim()}{`);
      document.head.appendChild(style);
    },
    store: {
      get(k, d) { try { const v = localStorage.getItem(`fleet.gui.${id}.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
      set(k, v) { try { localStorage.setItem(`fleet.gui.${id}.${k}`, JSON.stringify(v)); } catch {} },
    },
    md: renderMd,
    toast,
    _cleanup() { listeners.forEach(([t, h]) => es.removeEventListener(t, h)); stops.forEach(s => s()); },
  };
}

async function loadWidgets() {
  const ids = await _fetch('/api/widgets');
  const widgets = [];
  for (const id of ids) {
    try {
      const mod = await import(`/widgets/${id}/widget.js`);
      widgets.push({ id, mod });
    } catch (e) {
      console.error('widget failed to load', id, e);
    }
  }
  return widgets;
}

function buildShell(widgets) {
  const panels = {};
  for (const { id, mod } of widgets) {
    const meta = mod.meta || {};
    const panel = meta.panel || 'dashboard';
    (panels[panel] = panels[panel] || []).push({ id, mod, meta });
  }
  const names = Object.keys(panels).sort((a, b) => {
    const ia = PANEL_ORDER.indexOf(a), ib = PANEL_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

  panelsEl.innerHTML = '';
  tabbarEl.innerHTML = '';
  names.forEach((name, i) => {
    const section = document.createElement('section');
    section.className = 'panel';
    section.dataset.panel = name;
    section.hidden = i !== 0;
    panelsEl.appendChild(section);

    const items = panels[name].slice().sort(
      (a, b) => (a.meta.order ?? 50) - (b.meta.order ?? 50) || a.id.localeCompare(b.id)
    );
    for (const { id, mod, meta } of items) {
      const root = document.createElement(meta.full ? 'div' : 'article');
      root.className = meta.full ? 'widget-full' : 'card';
      root.dataset.w = id;
      if (!meta.full) {
        const h = document.createElement('h2');
        h.textContent = meta.title || id;
        root.appendChild(h);
      }
      const inner = document.createElement('div');
      inner.className = 'widget-body';
      root.appendChild(inner);
      section.appendChild(root);
      try { mod.mount(makeCtx(id, inner)); } catch (e) { console.error('mount failed', id, e); }
    }

    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.textContent = name;
    btn.dataset.panel = name;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.panel').forEach(p => { p.hidden = p.dataset.panel !== name; });
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.panel === name));
    });
    if (i === 0) btn.classList.add('active');
    tabbarEl.appendChild(btn);
  });
}

connectSSE();
loadWidgets().then(buildShell);
