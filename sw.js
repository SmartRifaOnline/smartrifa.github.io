/* Smart Rifa – funcionamento offline */
/* Abre na hora pelo que está guardado no aparelho e atualiza em segundo plano (a versão nova aparece na próxima abertura). */
const VERSAO='smart-rifa-v51';
const BASE=['./','./index.html','./supabase.js','./nuvem.js','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png','./icons/maskable-512.png','./icons/apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(VERSAO).then(c=>c.addAll(BASE)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==VERSAO&&!k.endsWith('-libs')).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;
  const u=new URL(r.url);
  if(u.origin===location.origin){
    e.respondWith(caches.open(VERSAO).then(c=>c.match(r,{ignoreSearch:true}).then(m=>{
      const rede=fetch(r).then(res=>{if(res.ok)c.put(r,res.clone());return res});
      if(m){e.waitUntil(rede.catch(()=>{}));return m;}
      return rede.catch(()=>c.match('./index.html'));
    })));
    return;
  }
  if(/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(u.href)){
    e.respondWith(caches.open('smart-rifa-libs').then(c=>c.match(r).then(m=>m||fetch(r).then(res=>{c.put(r,res.clone());return res}))));
  }
});
