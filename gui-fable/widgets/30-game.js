// Game area. Plugin contract: window.fleetGame = {init(ctx, api), frame(ctx, dt), pointer(ev, kind)} — put plugins in widgets/ as NN-game-*.js exporting {game:true, ...contract}.
export default {
  name: 'game', icon: '◉',
  async mount(el, api) {
    this.api=api; const cv=api.el('canvas',{style:'width:100%;height:60vh;border-radius:14px;background:#0f131a;touch-action:none;display:block'}); el.append(api.el('div',{class:'card'},cv));
    const ctx=cv.getContext('2d'); const fit=()=>{const r=cv.getBoundingClientRect();const w=Math.round(r.width*devicePixelRatio),h=Math.round(r.height*devicePixelRatio);if(w&&(cv.width!==w||cv.height!==h)){cv.width=w;cv.height=h;ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0)}}; addEventListener('resize',fit);
    const names=(await api.get('/widgets/')).filter(n=>n.includes('game-')); const plugins=[];
    for(const n of names){ const m=await import('/widgets/'+n+'?v='+Date.now()); if(m.default?.game){plugins.push(m.default); m.default.init?.(ctx,api,cv);} }
    if(!plugins.length){ // default: touch dots demo so the surface is provably interactive
      const dots=[]; plugins.push({frame(c){c.clearRect(0,0,cv.width,cv.height);c.fillStyle='#5ec1ff';dots.forEach(d=>{c.beginPath();c.arc(d.x,d.y,d.r,0,7);c.fill();d.r=Math.max(6,d.r*0.97)});c.fillStyle='#8a93a6';c.font='13px system-ui';c.fillText('no game plugin loaded — tap to draw · drop widgets/40-game-foo.js',12,20)},
        pointer(e){const r=cv.getBoundingClientRect();dots.push({x:e.clientX-r.left,y:e.clientY-r.top,r:22});if(dots.length>200)dots.shift()}}); }
    for(const k of ['pointerdown','pointermove']) cv.addEventListener(k,e=>{ if(k==='pointermove'&&!e.buttons)return; e.preventDefault(); plugins.forEach(p=>p.pointer?.(e,k)); });
    let last=performance.now(); const loop=t=>{fit();const dt=(t-last)/1000;last=t;plugins.forEach(p=>p.frame?.(ctx,dt));requestAnimationFrame(loop)}; requestAnimationFrame(loop);
  }
}
