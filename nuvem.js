/* Smart Rifa – sistema online: login, acessos e salvamento automático na nuvem (Supabase) */
/* Os dados ficam em documentos: um por rifa ("rifa:<id>") e um "geral" (ajustes, contatos, registro de atividades...).
   Cada alteração é enviada sozinha; se outra pessoa salvou o mesmo documento antes, as duas versões são juntadas. */
var SRSYNC=(function(){
'use strict';
var URL_='https://jkytrjkdafugekjwvftn.supabase.co';
var CHAVE='sb_publishable_exrE0gQazzreXYNnjr-jCw_DH-62EPS';
var BKEY='rifas_nuvem_base_v1', PKEY='rifas_nuvem_perfil_v1';
var FORA={rifas:1,users:1,sel:1,rec:1};
var sb=null;
try{ sb=window.supabase.createClient(URL_,CHAVE,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storageKey:'smartrifa-auth'}}); }catch(e){}
var recuperando=/type=recovery/.test(location.hash||'');
var H=null, base={}, perfil=null, canal=null, tmr=null, enviando=false, denovo=false, estado='', ouvintes=[], lerTodos=null;

function ok(){ return !!sb; }
function lerBase(){ try{ base=JSON.parse(localStorage.getItem(BKEY))||{}; }catch(e){ base={}; } }
function gravaBase(){ try{ localStorage.setItem(BKEY,JSON.stringify(base)); }catch(e){} }
function marca(s){ if(s===estado) return; estado=s; ouvintes.forEach(function(f){ try{ f(s); }catch(e){} }); }
function aoMudarEstado(f){ ouvintes.push(f); f(estado); }

/* ---------- juntar versões (base = última versão vinda da nuvem) ---------- */
function J(x){ return JSON.stringify(x); }
function igual(a,b){ return J(a)===J(b); }
function obj(x){ return !!x&&typeof x==='object'&&!Array.isArray(x); }
function merge3(b,l,r){
  if(igual(l,r)||igual(r,b)) return l;
  if(igual(l,b)) return r;
  if(obj(b)&&obj(l)&&obj(r)){
    var o={}, ks={};
    [b,l,r].forEach(function(x){ Object.keys(x).forEach(function(k){ ks[k]=1; }); });
    Object.keys(ks).forEach(function(k){ var v=merge3(b[k],l[k],r[k]); if(v!==undefined) o[k]=v; });
    return o;
  }
  if(Array.isArray(l)&&Array.isArray(r)) return mergeLista(Array.isArray(b)?b:[],l,r);
  return l;
}
function chave(x){ return obj(x)&&x.id!=null?'i:'+x.id:'j:'+J(x); }
function quando(x){ return obj(x)?(x.t||x.em||x.ts||''):''; }
function mergeLista(b,l,r){
  var mb={}, ml={}, mr={};
  b.forEach(function(x){ mb[chave(x)]=x; }); l.forEach(function(x){ ml[chave(x)]=x; }); r.forEach(function(x){ mr[chave(x)]=x; });
  var out=[], visto={};
  l.forEach(function(x){ var k=chave(x); if(visto[k]) return; visto[k]=1;
    if(k in mr) out.push(merge3(mb[k],x,mr[k]));
    else if(!(k in mb)) out.push(x); });
  r.forEach(function(x){ var k=chave(x); if(visto[k]) return; visto[k]=1; if(!(k in mb)) out.push(x); });
  if(out.length&&out.every(function(x){ return typeof quando(x)==='string'&&quando(x); })) out.sort(function(a,c){ return quando(a)<quando(c)?1:quando(a)>quando(c)?-1:0; });
  return out;
}

/* ---------- dados do sistema <-> documentos ---------- */
function divide(st){
  var d={}, g={};
  Object.keys(st).forEach(function(k){ if(!FORA[k]) g[k]=st[k]; });
  g.ordem=st.rifas.map(function(r){ return r.id; });
  d.geral=g;
  /* a imagem de capa (grande) fica num documento separado, para cada venda não reenviar a imagem */
  st.rifas.forEach(function(r){
    if(r.capa){ var c={}; Object.keys(r).forEach(function(k){ if(k!=='capa') c[k]=r[k]; }); d['rifa:'+r.id]=c; d['capa:'+r.id]={id:r.id,capa:r.capa}; }
    else d['rifa:'+r.id]=r;
  });
  return d;
}
function junta(docs,sel){
  var g=docs.geral||{}, o={};
  Object.keys(g).forEach(function(k){ if(k!=='ordem') o[k]=g[k]; });
  var ordem=g.ordem||[], rs=[];
  Object.keys(docs).forEach(function(id){ var x=docs[id]; if(id.indexOf('rifa:')===0&&x&&!x._apagada) rs.push(x); });
  rs=rs.map(function(r){ var c=docs['capa:'+r.id]; if(!c||c._apagada||!c.capa) return r; var x={}; Object.keys(r).forEach(function(k){ x[k]=r[k]; }); x.capa=c.capa; return x; });
  rs.sort(function(a,b){ var i=ordem.indexOf(a.id), j=ordem.indexOf(b.id); return (i<0?1e9:i)-(j<0?1e9:j); });
  o.rifas=rs; o.users=[]; o.sel=sel;
  return o;
}
function docsLocais(){
  var d=divide(H.pega());
  Object.keys(base).forEach(function(id){
    if(id in d) return;
    var b=null; try{ b=JSON.parse(base[id].j); }catch(e){}
    /* capa de uma rifa que este aparelho ainda não tem: fica como está */
    if(id.indexOf('capa:')===0&&!(('rifa:'+id.slice(5)) in d)){ d[id]=b; return; }
    d[id]=b&&b._apagada?b:{_apagada:true,id:id.slice(5)};
  });
  return d;
}
function aplica(muda){
  var st=H.pega(), d=divide(st);
  Object.keys(muda).forEach(function(id){ d[id]=muda[id]; });
  H.poe(junta(d,st.sel));
}

/* ---------- envio ---------- */
function podeEnviar(){ return !!(sb&&H&&perfil&&perfil.status==='ativo'&&perfil.role!=='espelho'); }
function agenda(ms){ clearTimeout(tmr); tmr=setTimeout(envia,ms==null?700:ms); }
function pendentes(){
  if(!H) return [];
  var d=docsLocais();
  return Object.keys(d).filter(function(id){ return !base[id]||base[id].j!==J(d[id]); }).map(function(id){ return [id,d[id]]; });
}
function envia(){
  if(!podeEnviar()) return Promise.resolve();
  if(enviando){ denovo=true; return Promise.resolve(); }
  var L=pendentes(); if(!L.length){ marca('ok'); return Promise.resolve(); }
  enviando=true; marca('enviando');
  var p=Promise.resolve();
  L.forEach(function(x){ p=p.then(function(){ return enviaUm(x[0],x[1],0); }); });
  return p.then(function(){ enviando=false; if(denovo){ denovo=false; agenda(200); } else marca(pendentes().length?'enviando':'ok'); },
    function(e){ enviando=false; denovo=false; marca(navigator.onLine===false?'offline':'erro'); try{ console.warn('Smart Rifa: falha ao salvar na nuvem',e); }catch(x){} agenda(15000); });
}
function enviaUm(id,data,t){
  if(t>5) return Promise.resolve();
  var b=base[id], j=J(data);
  var q=b?sb.from('docs').update({data:data,version:b.v+1}).eq('id',id).eq('version',b.v).select('version')
         :sb.from('docs').insert({id:id,data:data,version:1}).select('version');
  return q.then(function(r){
    if(!r.error&&r.data&&r.data.length){ base[id]={v:r.data[0].version,j:j}; gravaBase(); return; }
    if(r.error&&!(r.error.code==='23505')) throw r.error;
    /* outra pessoa salvou antes: junta as duas versões e tenta de novo */
    return sb.from('docs').select('data,version').eq('id',id).maybeSingle().then(function(q2){
      if(q2.error) throw q2.error;
      if(!q2.data) throw new Error('sem permissão para salvar');
      var bd=b?JSON.parse(b.j):undefined, rd=q2.data.data, m=merge3(bd,data,rd);
      base[id]={v:q2.data.version,j:J(rd)}; gravaBase();
      var muda={}; muda[id]=m; aplica(muda);
      if(J(m)===base[id].j) return;
      return enviaUm(id,m,t+1);
    });
  });
}

/* ---------- recebimento ---------- */
/* recebe uma lista de documentos [{id,data,version}] de uma vez e junta com o que há neste aparelho */
function recebe(L){
  var d=docsLocais(), muda={}, n=0, pend=false;
  L.forEach(function(x){
    var id=x.id, b=base[id]; if(b&&b.v>=x.version) return;
    var loc=d[id], fim;
    if(!b||loc===undefined||J(loc)===b.j) fim=x.data;
    else fim=merge3(JSON.parse(b.j),loc,x.data);
    base[id]={v:x.version,j:J(x.data)};
    muda[id]=fim; n++; if(J(fim)!==base[id].j) pend=true;
  });
  if(!n) return;
  gravaBase(); aplica(muda);
  if(pend) agenda();
}
function puxaTudo(){
  if(!sb) return Promise.resolve(false);
  return sb.from('docs').select('id,data,version').then(function(r){
    if(r.error) throw r.error;
    var vazia=!r.data.length;
    recebe(r.data);
    if(lerTodos){ lerTodos(); lerTodos=null; }
    agenda(vazia?100:700);
    return true;
  });
}
function puxaUm(id){
  return sb.from('docs').select('data,version').eq('id',id).maybeSingle().then(function(r){ if(!r.error&&r.data) recebe([{id:id,data:r.data.data,version:r.data.version}]); });
}
function escuta(){
  if(canal||!sb) return;
  canal=sb.channel('docs-mudancas').on('postgres_changes',{event:'*',schema:'public',table:'docs'},function(p){
    var n=p&&p.new; if(!n||!n.id) return;
    var b=base[n.id]; if(b&&n.version&&b.v>=n.version) return;
    puxaUm(n.id);
  }).subscribe(function(s){ if(s==='SUBSCRIBED') puxaTudo().catch(function(){}); });
}

/* ---------- contas ---------- */
function traduz(e){
  var m=(e&&(e.message||e.erro))||String(e||'');
  if(/invalid login|invalid credentials/i.test(m)) return 'E-mail ou senha incorretos.';
  if(/email not confirmed/i.test(m)) return 'Este e-mail ainda não foi confirmado.';
  if(/rate limit|too many/i.test(m)) return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
  if(/fetch|network|failed to/i.test(m)) return 'Sem conexão com a internet. Tente de novo.';
  if(/should be different/i.test(m)) return 'A nova senha precisa ser diferente da atual.';
  if(/password/i.test(m)&&/6/.test(m)) return 'A senha precisa ter pelo menos 6 caracteres.';
  return m||'Não foi possível concluir.';
}
function guardaPerfil(p){ perfil=p; try{ if(p) localStorage.setItem(PKEY,J(p)); else localStorage.removeItem(PKEY); }catch(e){} }
function perfilGuardado(id){ try{ var p=JSON.parse(localStorage.getItem(PKEY)); return p&&p.id===id?p:null; }catch(e){ return null; } }
function carregaPerfil(user){
  return sb.from('profiles').select('id,email,nome,tel,role,status').eq('id',user.id).maybeSingle().then(function(r){
    if(r.error) throw r.error;
    if(!r.data) return {id:user.id,email:user.email,nome:'',role:'vendedor',status:'pendente'};
    return r.data;
  });
}
/* sessão atual: devolve o perfil (ou null). Sem internet, usa o último perfil guardado neste aparelho. */
function sessao(){
  if(!sb) return Promise.resolve(null);
  return sb.auth.getSession().then(function(r){
    var s=r&&r.data&&r.data.session; if(!s) return null;
    return carregaPerfil(s.user).then(function(p){ guardaPerfil(p); return p; },function(){ var p=perfilGuardado(s.user.id); perfil=p; return p; });
  });
}
function entrar(email,senha){
  return sb.auth.signInWithPassword({email:String(email).trim().toLowerCase(),password:senha}).then(function(r){
    if(r.error) throw new Error(traduz(r.error));
    return carregaPerfil(r.data.user).then(function(p){ guardaPerfil(p); return p; });
  });
}
function sair(){ desliga(); guardaPerfil(null); if(!sb) return Promise.resolve(); return sb.auth.signOut().catch(function(){}); }
function funcao(corpo){
  return sb.functions.invoke('acessos',{body:corpo}).then(function(r){
    if(r.error){
      var ctx=r.error.context;
      if(ctx&&ctx.json) return ctx.json().then(function(o){ throw new Error((o&&o.erro)||traduz(r.error)); },function(){ throw new Error(traduz(r.error)); });
      throw new Error(traduz(r.error));
    }
    if(r.data&&r.data.erro) throw new Error(r.data.erro);
    return r.data;
  });
}
function pedirAcesso(nome,email,senha){ return funcao({acao:'pedir',nome:nome,email:email,senha:senha}); }
function recuperar(email){
  var volta=location.origin+location.pathname;
  return sb.auth.resetPasswordForEmail(String(email).trim().toLowerCase(),{redirectTo:volta}).then(function(r){ if(r.error) throw new Error(traduz(r.error)); });
}
function novaSenha(senha){
  return sb.auth.updateUser({password:senha}).then(function(r){
    if(r.error) throw new Error(traduz(r.error));
    recuperando=false; try{ history.replaceState(null,'',location.pathname); }catch(e){}
  });
}
function emRecuperacao(){ return recuperando; }
if(sb) sb.auth.onAuthStateChange(function(ev){ if(ev==='PASSWORD_RECOVERY'){ recuperando=true; if(H&&H.recuperacao) H.recuperacao(); } });

/* administração de acessos */
function perfis(){ return sb.from('profiles').select('id,email,nome,tel,role,status,criado_em').order('criado_em').then(function(r){ if(r.error) throw new Error(traduz(r.error)); return r.data; }); }
function mudaPerfil(id,campos){ return sb.from('profiles').update(campos).eq('id',id).select('id').then(function(r){ if(r.error) throw new Error(/administrador ativo/.test(r.error.message)?'Precisa existir ao menos um administrador ativo.':traduz(r.error)); if(!r.data||!r.data.length) throw new Error('Sem permissão.'); }); }
function criaAcesso(o){ o.acao='criar'; return funcao(o); }
function trocaSenha(id,senha){ return funcao({acao:'senha',id:id,senha:senha}); }
function excluiAcesso(id){ return funcao({acao:'excluir',id:id}); }
function backups(){ return sb.from('backups').select('id,slot,tipo,criado_em').order('criado_em',{ascending:false}).then(function(r){ if(r.error) throw new Error(traduz(r.error)); return r.data; }); }
function backup(id){ return sb.from('backups').select('criado_em,dados').eq('id',id).single().then(function(r){ if(r.error) throw new Error(traduz(r.error)); return {em:r.data.criado_em,st:junta(r.data.dados,null)}; }); }

/* ---------- ligar / desligar a sincronização ---------- */
function liga(h){
  H=h; lerBase();
  window.addEventListener('online',function(){ agenda(300); puxaTudo().catch(function(){}); });
  window.addEventListener('offline',function(){ marca('offline'); });
  document.addEventListener('visibilitychange',function(){ if(document.visibilityState==='visible'&&perfil) puxaTudo().catch(function(){}); });
}
/* começa a sincronizar; "pronto" é chamado depois da primeira leitura da nuvem (ou na hora, se estiver sem internet) */
function conecta(pronto){
  var feito=false; function fim(){ if(!feito){ feito=true; pronto&&pronto(); } }
  lerTodos=fim;
  if(navigator.onLine===false){ marca('offline'); fim(); }
  puxaTudo().then(function(){ escuta(); },function(){ marca(navigator.onLine===false?'offline':'erro'); fim(); escuta(); });
  setTimeout(fim,8000);
}
function desliga(){ clearTimeout(tmr); if(canal&&sb){ try{ sb.removeChannel(canal); }catch(e){} } canal=null; }

return {ok:ok,liga:liga,conecta:conecta,desliga:desliga,agenda:agenda,aoMudarEstado:aoMudarEstado,sessao:sessao,entrar:entrar,sair:sair,
  pedirAcesso:pedirAcesso,recuperar:recuperar,novaSenha:novaSenha,emRecuperacao:emRecuperacao,perfil:function(){ return perfil; },
  perfis:perfis,mudaPerfil:mudaPerfil,criaAcesso:criaAcesso,trocaSenha:trocaSenha,excluiAcesso:excluiAcesso,backups:backups,backup:backup,
  _merge3:merge3,_divide:divide,_junta:junta};
})();
