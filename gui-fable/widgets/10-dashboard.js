export default {
  name: 'dashboard', icon: '▣',
  async mount(el, api) {
    this.api = api;
    this.st = api.el('div', {class:'card'}, api.el('h2',{}, 'threads'), api.el('div',{class:'scroll'}));
    const send = api.el('div', {class:'card'}, api.el('h2',{}, 'send'));
    this.sel = api.el('select'); this.txt = api.el('textarea', {rows:'3', placeholder:'packet…'});
    this.out = api.el('div', {class:'mono'});
    send.append(this.sel, api.el('div',{style:'height:8px'}), this.txt, api.el('div',{style:'height:8px'}),
      api.el('div',{class:'row'}, api.el('button',{class:'btn', onclick:()=>this.send()}, 'fleet send'), this.out));
    this.ho = api.el('div', {class:'card'}, api.el('h2',{}, 'handoffs'));
    this.lg = api.el('div', {class:'card'}, api.el('h2',{}, 'ledger'));
    el.append(this.st, send, this.ho, this.lg);
    await this.refresh();
  },
  async send() {
    this.out.textContent='…'; const r = await this.api.post('/api/send', {thread:this.sel.value, text:this.txt.value});
    this.out.textContent = r.out || r.error; if(r.rc===0) this.txt.value='';
  },
  async refresh() {
    const api=this.api; const [rows, ho, lg] = await Promise.all([api.get('/api/status'), api.get('/api/handoffs?n=8'), api.get('/api/ledger?n=25')]);
    const box=this.st.lastChild; box.innerHTML='';
    if(rows.error){ box.textContent=rows.error; return; }
    const t=api.el('table',{}, api.el('tr',{}, ...['thread','tier','state','warmth','idle','ctx','$','resume$','respawn$','flags'].map(h=>api.el('th',{},h))));
    for(const r of rows){ const flags=[r.spec_stale?'STALE-SPEC':'', r.last_handoff?'handoff':'', r.miss_reason?'miss:'+r.miss_reason:''].filter(Boolean).join(' ');
      t.append(api.el('tr',{}, api.el('td',{},r.name), api.el('td',{},r.tier), api.el('td',{},r.state), api.el('td',{class:r.warmth},r.warmth), api.el('td',{},r.idle_minutes+'m'), api.el('td',{},(r.context/1000).toFixed(0)+'k'),
        api.el('td',{},r.dollars<0?'?':r.dollars.toFixed(2)), api.el('td',{},r.resume_usd<0?'?':r.resume_usd.toFixed(2)), api.el('td',{},r.respawn_usd<0?'?':r.respawn_usd.toFixed(2)), api.el('td',{class:'tag'},flags))); }
    box.append(t);
    const cur=this.sel.value; this.sel.innerHTML=''; rows.forEach(r=>this.sel.append(api.el('option',{value:r.name},r.name))); if(cur) this.sel.value=cur;
    this.ho.replaceChildren(api.el('h2',{},'handoffs'), ...ho.map(h=>api.el('div',{class:'row',style:'padding:6px 0;border-top:1px solid #222'}, api.el('span',{class:'tag'},h.thread), api.el('span',{style:'flex:1'},h.title.replace(/^#+\s*/,'')), api.el('span',{class:'tag'},api.fmtAge(h.mtime)))));
    this.lg.replaceChildren(api.el('h2',{},'ledger'), ...lg.map(e=>api.el('div',{class:'mono',style:'padding:4px 0;border-top:1px solid #222'}, `${api.fmtAge(e.t).padStart(4)} ${e.ev.padEnd(13)} ${e.thread||''} ${e.from?'←'+e.from:''} ${e.reason||''} ${e.bytes?e.bytes+'B':''}`)));
  }
}
