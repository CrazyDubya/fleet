// ?debug=1 tuning panel — DOM only. Mutates live object fields (world.tuning, flipper
// instances) rather than the frozen module-level constants, so changes take effect
// immediately without a reload.
export function isDebugEnabled() {
  return new URLSearchParams(window.location.search).get('debug') === '1';
}

function row(label, min, max, step, value, onInput) {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display:flex;gap:6px;align-items:center;font:11px monospace;color:#fff;';
  const span = document.createElement('span');
  span.textContent = label;
  span.style.width = '110px';
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min, max, step, value });
  input.style.width = '120px';
  const out = document.createElement('span');
  out.textContent = value;
  input.addEventListener('input', () => {
    out.textContent = input.value;
    onInput(parseFloat(input.value));
  });
  wrap.append(span, input, out);
  return wrap;
}

export function mountDebugPanel(world, flippers) {
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;top:8px;left:8px;background:rgba(0,0,0,0.6);padding:8px;border-radius:6px;z-index:10;display:flex;flex-direction:column;gap:4px;';

  panel.append(row('mu (friction)', 0, 0.5, 0.01, world.tuning.mu, (v) => (world.tuning.mu = v)));
  panel.append(row('k_drag', 0, 1, 0.01, world.tuning.kDrag, (v) => (world.tuning.kDrag = v)));

  for (const [name, flipper] of Object.entries(flippers)) {
    if (!flipper) continue;
    panel.append(row(`${name} e`, 0, 1.2, 0.01, flipper.restitution, (v) => (flipper.restitution = v)));
    panel.append(row(`${name} upMs`, 5, 120, 1, flipper.upMs, (v) => (flipper.upMs = v)));
    panel.append(row(`${name} downMs`, 5, 150, 1, flipper.downMs, (v) => (flipper.downMs = v)));
  }

  document.body.appendChild(panel);
  return panel;
}

/** A scrolling switch-event log for ?debug=1 — satisfies "visible in a debug event log"
 * for T4's scoring mechanisms without building the real HUD (ui/hud.js, T12). */
export function mountEventLog(maxLines = 20) {
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;bottom:8px;left:8px;width:220px;max-height:40vh;overflow:hidden;background:rgba(0,0,0,0.6);color:#9f9;font:11px monospace;padding:6px;border-radius:6px;z-index:10;display:flex;flex-direction:column-reverse;';
  document.body.appendChild(panel);
  const lines = [];
  return {
    log(tag) {
      lines.push(`${new Date().toISOString().slice(11, 19)} ${tag}`);
      if (lines.length > maxLines) lines.shift();
      panel.textContent = lines.slice().reverse().join('\n');
    },
  };
}
