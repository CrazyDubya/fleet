export function md(text) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = text.split('\n');
  let html = '', inCode = false, listOpen = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) { html += '</code></pre>'; inCode = false; }
      else { if (listOpen) { html += '</ul>'; listOpen = false; } html += '<pre><code>'; inCode = true; }
      continue;
    }
    if (inCode) { html += esc(line) + '\n'; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      if (listOpen) { html += '</ul>'; listOpen = false; }
      html += `<h${h[1].length}>${inline(esc(h[2]))}</h${h[1].length}>`;
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) {
      if (!listOpen) { html += '<ul>'; listOpen = true; }
      html += `<li>${inline(esc(li[1]))}</li>`;
      continue;
    }
    if (listOpen) { html += '</ul>'; listOpen = false; }
    if (line.trim() === '') continue;
    html += `<p>${inline(esc(line))}</p>`;
  }
  if (listOpen) html += '</ul>';
  if (inCode) html += '</code></pre>';
  return html;
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
      const safe = /^(https?:|mailto:|\/|#)/i.test(url.trim()) ? url : '#';
      return `<a href="${safe.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });
}
