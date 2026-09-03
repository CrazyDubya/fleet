// Threads push here: POST /api/push {"title","body","kind":"md|html"}  or drop a file in gui-fable/inbox/
export default {
  name: 'workspace', icon: '✎',
  async mount(el, api) { this.api=api; this.list=api.el('div'); el.append(api.el('div',{class:'card mono',style:'color:var(--dim)'},'push: curl -X POST http://HOST:8765/api/push -d \'{"title":"t","body":"..."}\'  |  or drop a file in gui-fable/inbox/'), this.list); await this.refresh(); },
  async refresh() {
    const api=this.api; const items=await api.get('/api/inbox'); this.list.replaceChildren(...items.map(i=>{
      const c=api.el('div',{class:'card'}, api.el('h2',{}, i.name+' · '+api.fmtAge(i.mtime)));
      if(i.name.endsWith('.html')){ const f=api.el('iframe',{sandbox:'allow-scripts',style:'width:100%;border:0;min-height:200px;border-radius:10px;background:#fff'}); f.srcdoc=i.body; c.append(f); }
      else c.append(api.el('div',{class:'mono'}, i.body));
      return c; }));
    if(!items.length) this.list.append(api.el('div',{class:'card',style:'color:var(--dim)'},'nothing pushed yet'));
  }
}
