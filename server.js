/**
 * Eleição de Oficiais da Igreja — Servidor v4.6
 * Node.js puro, zero dependências externas.
 *
 * v4.6:
 *  - presentes: [{id, dataHora}] — registra data/hora de cada check-in
 *  - migração automática de presentes legados (array de strings)
 *  - filtro e ordenação na presença (frontend)
 *  - candidatos sem campo descrição
 */
'use strict';
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const crypto = require('crypto');
const { buildXLSX } = require('./xlsx-builder');
const { readXLSX }  = require('./xlsx-reader');

const PORT      = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'state.json');
const FOTOS_DIR = path.join(__dirname, 'public', 'fotos');
const LOGO_DIR  = path.join(__dirname, 'public', 'logos');
const APP_NAME  = 'Eleição de Oficiais da Igreja';
const VERSION   = '4.6';

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const _loginAttempts = new Map();
const RATE_LIMIT = 5, RATE_WINDOW = 15 * 60 * 1000;
function checkRate(ip) {
  const now = Date.now(), rec = _loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) { _loginAttempts.set(ip, { count:1, resetAt: now+RATE_WINDOW }); return true; }
  if (rec.count >= RATE_LIMIT) return false;
  rec.count++; return true;
}
function resetRate(ip) { _loginAttempts.delete(ip); }
setInterval(()=>{ const n=Date.now(); for(const[k,v]of _loginAttempts)if(n>v.resetAt)_loginAttempts.delete(k); }, RATE_WINDOW);

// ─── Sessões Admin ────────────────────────────────────────────────────────────
const _sessions = new Map();
function newToken()   { return crypto.randomBytes(32).toString('hex'); }
function sessionOk(t) { if(!t)return false; const s=_sessions.get(t); if(!s)return false; if(Date.now()>s.exp){_sessions.delete(t);return false;} return true; }
function mkSession()  { const t=newToken(); _sessions.set(t,{exp:Date.now()+8*3600*1000}); return t; }
function rmSession(t) { _sessions.delete(t); }
setInterval(()=>{ const n=Date.now(); for(const[k,v]of _sessions)if(n>v.exp)_sessions.delete(k); }, 3600*1000);

function hashPwd(s) { return crypto.createHash('sha256').update(s+'eleicao_salt_2024').digest('hex'); }

// ─── Helpers de presença ───────────────────────────────────────────────────────
// presentes é sempre [{id: string, dataHora: string ISO}]
// Funções para abstrair e garantir compatibilidade com dados antigos

function presIds(presentes) {
  // Aceita tanto [{id,dataHora}] quanto [string] (legado)
  return presentes.map(p => typeof p === 'string' ? p : p.id);
}
function presIncludes(presentes, id) {
  return presIds(presentes).includes(id);
}
function presAdd(presentes, id) {
  presentes.push({ id, dataHora: new Date().toISOString() });
}
function presRemove(presentes, id) {
  const idx = presIds(presentes).indexOf(id);
  if (idx >= 0) presentes.splice(idx, 1);
}
function presFindEntry(presentes, id) {
  return presentes.find(p => (typeof p === 'string' ? p : p.id) === id);
}

// ─── Migração de presentes legados ────────────────────────────────────────────
function migrarPresentes(presentes) {
  return presentes.map(p => {
    if (typeof p === 'string') return { id: p, dataHora: null }; // sem data conhecida
    return p;
  });
}

// ─── Estado padrão ────────────────────────────────────────────────────────────
const DEFAULT = {
  users: [
    { id:'u1', nome:'Ana Oliveira', cpf:'111.111.111-11' },
    { id:'u2', nome:'Bruno Santos', cpf:'222.222.222-22' },
    { id:'u3', nome:'Carla Mendes', cpf:'333.333.333-33' },
  ],
  candidatos: [
    { id:'c1', userId:'u1', nome:'Ana Oliveira', idade:42, fotoUrl:'' },
    { id:'c2', userId:'u2', nome:'Bruno Santos', idade:38, fotoUrl:'' },
  ],
  cargos:    [ { id:'g1', nome:'Diácono', vagas:2 }, { id:'g2', nome:'Presbítero', vagas:1 } ],
  presentes: [],   // [{id, dataHora}]
  jaVotou:   [], resultados: {}, elStatus: 'aguardando',
  config: { nomeInstituicao:APP_NAME, logoUrl:'', corPrimaria:'#185FA5', corSecundaria:'#3B6D11', corFundo:'#f0ede6', corTexto:'#1a1a18' },
  adminSenha: hashPwd('admin'),
};

// ─── Persistência ─────────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const s = JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
      if (!s.config)     s.config     = {...DEFAULT.config};
      if (!s.adminSenha) s.adminSenha = DEFAULT.adminSenha;
      s.users      = (s.users||[]).map(u=>({id:u.id,nome:u.nome,cpf:u.cpf}));
      s.candidatos = (s.candidatos||[]).map(c=>({userId:'',fotoUrl:'',...c,desc:undefined}));
      // Migração automática: presentes legados (array de strings → objetos)
      s.presentes  = migrarPresentes(s.presentes||[]);
      if (!s.config.nomeInstituicao||s.config.nomeInstituicao==='Igreja / Instituição') s.config.nomeInstituicao=APP_NAME;
      return s;
    }
  } catch(e) { console.error('Erro ao carregar estado:',e.message); }
  return JSON.parse(JSON.stringify(DEFAULT));
}
function saveState(st) {
  try { fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true}); fs.writeFileSync(DATA_FILE,JSON.stringify(st,null,2),'utf8'); }
  catch(e) { console.error('Erro ao salvar:',e.message); }
}
fs.mkdirSync(FOTOS_DIR,{recursive:true}); fs.mkdirSync(LOGO_DIR,{recursive:true});
let ST = loadState();
const genId = ()=>Math.random().toString(36).slice(2,9);

// ─── Validação CPF ────────────────────────────────────────────────────────────
function validCPF(cpf) {
  cpf=cpf.replace(/\D/g,'');
  if(cpf.length!==11||/^(\d)\1{10}$/.test(cpf))return false;
  let s=0;for(let i=0;i<9;i++)s+=+cpf[i]*(10-i);let r=(s*10)%11;if(r>=10)r=0;if(r!==+cpf[9])return false;
  s=0;for(let i=0;i<10;i++)s+=+cpf[i]*(11-i);r=(s*10)%11;if(r>=10)r=0;return r===+cpf[10];
}
function fmtCPF(cpf) {
  const d=cpf.replace(/\D/g,'');
  if(d.length!==11)return cpf;
  return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
}

// ─── Formata data/hora BR ─────────────────────────────────────────────────────
function fmtDataHora(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  } catch { return '—'; }
}

// ─── CSV ──────────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines=text.trim().split(/\r?\n/);if(lines.length<2)return[];
  const hdr=lines[0].split(',').map(h=>h.trim().replace(/^"|"$/g,'').toLowerCase());
  return lines.slice(1).map(line=>{const vals=line.split(',').map(v=>v.trim().replace(/^"|"$/g,''));const o={};hdr.forEach((h,i)=>o[h]=vals[i]||'');return o;});
}
function toCSV(rows,headers) {
  return[headers.join(','),...rows.map(r=>headers.map(h=>`"${(r[h]||'').toString().replace(/"/g,'""')}"`).join(','))].join('\n');
}

// ─── Importação de membros ────────────────────────────────────────────────────
function importarMembros(rows) {
  let added=0,skipped=0,erros=[];
  for(const r of rows){
    const nome=(r.nome||r['nome completo']||r['name']||'').trim();
    const cpfRaw=(r.cpf||r['cpf membro']||'').trim();
    if(!nome||!cpfRaw){skipped++;continue;}
    const cpfLimpo=cpfRaw.replace(/\D/g,'');
    if(!validCPF(cpfLimpo)){erros.push(`CPF inválido: ${cpfRaw}`);skipped++;continue;}
    const cpfFmt=fmtCPF(cpfLimpo);
    if(ST.users.find(u=>u.cpf===cpfFmt)){skipped++;continue;}
    ST.users.push({id:genId(),nome,cpf:cpfFmt});added++;
  }
  return{added,skipped,erros};
}

// ─── Multipart ────────────────────────────────────────────────────────────────
function parseMultipart(buf,boundary){
  const parts={},sep=Buffer.from('--'+boundary);let pos=0;
  while(pos<buf.length){
    const start=buf.indexOf(sep,pos);if(start===-1)break;pos=start+sep.length;
    if(buf[pos]===45&&buf[pos+1]===45)break;if(buf[pos]===13)pos+=2;
    const he=buf.indexOf('\r\n\r\n',pos);if(he===-1)break;
    const hs=buf.slice(pos,he).toString();pos=he+4;
    const ns=buf.indexOf(sep,pos),de=ns===-1?buf.length:ns-2;
    const data=buf.slice(pos,de);pos=ns;
    const nm=hs.match(/name="([^"]+)"/),fn=hs.match(/filename="([^"]+)"/);
    if(nm)parts[nm[1]]={data,filename:fn?fn[1]:null,text:!fn?data.toString():null};
  }
  return parts;
}
function rawBody(req)  { return new Promise((ok,ko)=>{const c=[];req.on('data',b=>c.push(b));req.on('end',()=>ok(Buffer.concat(c)));req.on('error',ko);}); }
function jsonBody(req) { return new Promise((ok,ko)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{ok(JSON.parse(b));}catch{ok(b);}});req.on('error',ko);}); }

// ─── Respostas ────────────────────────────────────────────────────────────────
const MIME={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml'};
function sendJSON(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
function sendHTML(res,html){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN'});res.end(html);}
function sendXLSX(res,buf,name){res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="${name}"`,'Content-Length':buf.length});res.end(buf);}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function getToken(req){const p=url.parse(req.url,true);return req.headers['x-admin-token']||p.query.t||'';}
function isAdmin(req) {return sessionOk(getToken(req));}
function deny(res)    {sendJSON(res,{error:'Não autorizado. Faça login como administrador.'},401);}
function getIP(req)   {return req.headers['x-forwarded-for']?.split(',')[0]||req.socket.remoteAddress||'unknown';}
function safeExt(fn)  {const ok=['.jpg','.jpeg','.png','.gif','.webp'];const e=path.extname(fn||'').toLowerCase();return ok.includes(e)?e:'.jpg';}

// ─── Apuração ─────────────────────────────────────────────────────────────────
function apurar(){
  const total=ST.presentes.length;
  return ST.cargos.map(cargo=>{
    const res=ST.resultados[cargo.id]||{},branco=res.branco||0;
    const rank=Object.entries(res).filter(([k])=>k!=='branco').map(([cid,v])=>{const c=ST.candidatos.find(x=>x.id===cid);return c?{cid,c,v}:null;}).filter(Boolean).sort((a,b)=>b.v-a.v);
    const maioria=Math.ceil(total/2),eleitos=rank.filter((r,i)=>i<cargo.vagas&&r.v>=maioria);
    return{cargo,rank,eleitos,branco,total,maioria};
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVIDOR
// ══════════════════════════════════════════════════════════════════════════════
const server = http.createServer(async(req,res)=>{
  const p=url.parse(req.url,true),pn=decodeURIComponent(p.pathname),m=req.method;
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Admin-Token');
  if(m==='OPTIONS'){res.writeHead(204);res.end();return;}

  // Arquivos estáticos
  if(m==='GET'&&(pn.startsWith('/fotos/')||pn.startsWith('/logos/'))){
    const safe=path.normalize(pn).replace(/^(\.\.(\/|\\|$))+/,'');
    const fp=path.join(__dirname,'public',safe);
    if(!fp.startsWith(path.join(__dirname,'public'))){res.writeHead(403);res.end();return;}
    if(fs.existsSync(fp)){res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'});fs.createReadStream(fp).pipe(res);}
    else{res.writeHead(404);res.end();}
    return;
  }

  // Páginas HTML
  if(m==='GET'&&pn==='/checkin')  {sendHTML(res,checkinPage());return;}
  if(m==='GET'&&pn==='/cadastro') {sendHTML(res,cadastroPage());return;}
  if(m==='GET'&&pn==='/datashow') {sendHTML(res,datashowPage());return;}
  if(m==='GET'&&pn==='/votar')    {const vf=path.join(__dirname,'public','votar.html');sendHTML(res,fs.readFileSync(vf,'utf8'));return;}

  if(!pn.startsWith('/api/')){
    const fp=path.join(__dirname,'public','index.html');
    if(fs.existsSync(fp))sendHTML(res,fs.readFileSync(fp,'utf8'));
    else sendHTML(res,'<h1>'+APP_NAME+' v'+VERSION+'</h1>');
    return;
  }

  // ── API Pública ──────────────────────────────────────────────────────────
  if(m==='GET'&&pn==='/api/state'){
    // Enriquece presentes com dados do usuário para o frontend
    const presentesRich = ST.presentes.map(p=>{
      const u = ST.users.find(x=>x.id===(typeof p==='string'?p:p.id));
      return {
        id: typeof p==='string'?p:p.id,
        dataHora: typeof p==='string'?null:p.dataHora,
        nome: u?u.nome:'',
        cpf:  u?u.cpf:'',
      };
    });
    return sendJSON(res,{
      users:ST.users, candidatos:ST.candidatos, cargos:ST.cargos,
      presentes:presentesRich,
      jaVotou:ST.jaVotou, elStatus:ST.elStatus,
      config:ST.config, version:VERSION,
    });
  }
  if(m==='GET'&&pn==='/api/config'){return sendJSON(res,ST.config);}

  if(m==='GET'&&pn==='/api/datashow'){
    const ids=presIds(ST.presentes);
    const naoVotouCount=ids.filter(id=>!ST.jaVotou.includes(id)).length;
    const ap=ST.elStatus==='encerrada'?apurar():null;
    return sendJSON(res,{
      elStatus:ST.elStatus,presentes:ST.presentes.length,jaVotou:ST.jaVotou.length,naoVotouCount,
      apuracao:ap?ap.map(a=>({cargo:a.cargo.nome,vagas:a.cargo.vagas,branco:a.branco,maioria:a.maioria,rank:a.rank.map(r=>({nome:r.c.nome,votos:r.v,eleito:a.eleitos.some(e=>e.cid===r.cid)}))})):null,
      config:ST.config,
    });
  }

  if(m==='POST'&&pn==='/api/login'){
    const ip=getIP(req);
    if(!checkRate(ip))return sendJSON(res,{error:'Muitas tentativas. Aguarde 15 minutos.'},429);
    const{cpf,pwd}=await jsonBody(req);
    if(cpf==='admin'&&hashPwd(pwd)===ST.adminSenha){resetRate(ip);return sendJSON(res,{ok:true,role:'admin',token:mkSession()});}
    return sendJSON(res,{error:'Credenciais inválidas.'},401);
  }
  if(m==='POST'&&pn==='/api/logout'){rmSession(getToken(req));return sendJSON(res,{ok:true});}
  if(m==='GET'&&pn==='/api/auth/check'){return sendJSON(res,{valid:isAdmin(req),role:isAdmin(req)?'admin':null});}

  if(m==='POST'&&pn==='/api/login-eleitor'){
    const{cpf}=await jsonBody(req);
    const u=ST.users.find(x=>x.cpf===cpf);
    if(!u)return sendJSON(res,{error:'CPF não encontrado no cadastro.'},401);
    if(!presIncludes(ST.presentes,u.id))return sendJSON(res,{error:'Você não está marcado como presente.'},403);
    if(ST.jaVotou.includes(u.id))return sendJSON(res,{error:'Você já votou nesta eleição.'},403);
    return sendJSON(res,{ok:true,user:{id:u.id,nome:u.nome,cpf:u.cpf},elStatus:ST.elStatus});
  }

  if(m==='POST'&&pn==='/api/votar'){
    const{userId,votos}=await jsonBody(req);
    if(!userId||!votos)return sendJSON(res,{error:'Dados inválidos.'},400);
    if(ST.elStatus!=='ativa')return sendJSON(res,{error:'Eleição não está ativa.'},403);
    if(!presIncludes(ST.presentes,userId))return sendJSON(res,{error:'Usuário não está presente.'},403);
    if(ST.jaVotou.includes(userId))return sendJSON(res,{error:'Usuário já votou.'},409);
    ST.cargos.forEach(g=>{
      if(!ST.resultados[g.id])ST.resultados[g.id]={branco:0};
      const sel=Array.isArray(votos[g.id])?votos[g.id]:[];
      const sv=sel.filter(cid=>ST.candidatos.find(c=>c.id===cid)).slice(0,g.vagas);
      ST.resultados[g.id].branco+=(g.vagas-sv.length);
      sv.forEach(cid=>{ST.resultados[g.id][cid]=(ST.resultados[g.id][cid]||0)+1;});
    });
    ST.jaVotou.push(userId);saveState(ST);
    return sendJSON(res,{ok:true});
  }

  if(m==='GET'&&pn==='/api/resultados'){
    if(ST.elStatus!=='encerrada')return sendJSON(res,{error:'Eleição ainda não encerrada.'},403);
    return sendJSON(res,{resultados:ST.resultados,cargos:ST.cargos,candidatos:ST.candidatos,apuracao:apurar(),totalPresentes:ST.presentes.length});
  }

  if(m==='POST'&&pn==='/api/checkin/buscar'){
    const{cpf}=await jsonBody(req);
    if(!cpf)return sendJSON(res,{error:'CPF obrigatório.'},400);
    const u=ST.users.find(x=>x.cpf===cpf);
    if(!u)return sendJSON(res,{naoEncontrado:true,cpf});
    const entry=presFindEntry(ST.presentes,u.id);
    return sendJSON(res,{ok:true,user:{id:u.id,nome:u.nome,cpf:u.cpf},jaPresente:!!entry,dataHora:entry&&entry.dataHora||null});
  }

  if(m==='POST'&&pn==='/api/checkin/confirmar'){
    const{cpf}=await jsonBody(req);
    const u=ST.users.find(x=>x.cpf===cpf);
    if(!u)return sendJSON(res,{error:'CPF não encontrado.'},404);
    if(presIncludes(ST.presentes,u.id))return sendJSON(res,{ok:true,msg:'Presença já confirmada.',user:{id:u.id,nome:u.nome}});
    presAdd(ST.presentes,u.id);saveState(ST);
    return sendJSON(res,{ok:true,msg:'Presença confirmada!',user:{id:u.id,nome:u.nome}});
  }

  if(m==='POST'&&pn==='/api/cadastro-publico'){
    const{nome,cpf}=await jsonBody(req);
    if(!nome||!nome.trim())return sendJSON(res,{error:'Nome completo obrigatório.'},400);
    if(!cpf)return sendJSON(res,{error:'CPF obrigatório.'},400);
    const cpfLimpo=cpf.replace(/\D/g,'');
    if(!validCPF(cpfLimpo))return sendJSON(res,{error:'CPF inválido. Verifique os dígitos.'},400);
    const cpfFmt=fmtCPF(cpfLimpo);
    if(ST.users.find(u=>u.cpf===cpfFmt))return sendJSON(res,{error:'Este CPF já está cadastrado.'},409);
    const u={id:genId(),nome:nome.trim(),cpf:cpfFmt};
    ST.users.push(u);saveState(ST);
    return sendJSON(res,{ok:true,user:u});
  }

  // ══ Endpoints Admin ════════════════════════════════════════════════════════
  if(!isAdmin(req)){deny(res);return;}

  // Config
  if(m==='POST'&&pn==='/api/config'){const b=await jsonBody(req);ST.config={...ST.config,...b};saveState(ST);return sendJSON(res,{ok:true,config:ST.config});}
  if(m==='POST'&&pn==='/api/config/logo'){
    const ct=req.headers['content-type']||'',bm=ct.match(/boundary=([^\s;]+)/);
    if(!bm)return sendJSON(res,{error:'Content-Type inválido.'},400);
    const parts=parseMultipart(await rawBody(req),bm[1]),file=parts['logo'];
    if(!file?.filename)return sendJSON(res,{error:'Arquivo não enviado.'},400);
    const ext=safeExt(file.filename),fn='logo'+ext;
    fs.writeFileSync(path.join(LOGO_DIR,fn),file.data);
    ST.config.logoUrl='/logos/'+fn;saveState(ST);return sendJSON(res,{ok:true,logoUrl:ST.config.logoUrl});
  }
  if(m==='POST'&&pn==='/api/admin/senha'){
    const{senhaAtual,novaSenha}=await jsonBody(req);
    if(hashPwd(senhaAtual)!==ST.adminSenha)return sendJSON(res,{error:'Senha atual incorreta.'},403);
    if(!novaSenha||novaSenha.length<6)return sendJSON(res,{error:'Nova senha deve ter ao menos 6 caracteres.'},400);
    ST.adminSenha=hashPwd(novaSenha);saveState(ST);return sendJSON(res,{ok:true});
  }

  // Presença — marcar/desmarcar com timestamp
  if(m==='POST'&&pn==='/api/presenca/marcar-todos'){
    ST.presentes=ST.users.map(u=>{
      const ex=presFindEntry(ST.presentes,u.id);
      return ex||{id:u.id,dataHora:new Date().toISOString()};
    });
    saveState(ST);return sendJSON(res,{ok:true});
  }
  if(m==='POST'&&pn==='/api/presenca/desmarcar-todos'){
    ST.presentes=[];saveState(ST);return sendJSON(res,{ok:true});
  }
  if(m==='POST'&&pn.startsWith('/api/presenca/')){
    const id=pn.split('/')[3];
    if(!ST.users.find(u=>u.id===id))return sendJSON(res,{error:'Membro não encontrado.'},404);
    if(presIncludes(ST.presentes,id)){
      presRemove(ST.presentes,id);
    } else {
      presAdd(ST.presentes,id);
    }
    saveState(ST);return sendJSON(res,{ok:true});
  }

  // Exportar presença XLSX — inclui data/hora
  if(m==='GET'&&pn==='/api/presenca/exportar-xlsx'){
    const rows=ST.presentes
      .map(p=>{
        const id=typeof p==='string'?p:p.id;
        const dh=typeof p==='string'?null:p.dataHora;
        const u=ST.users.find(x=>x.id===id);
        return u?{nome:u.nome,cpf:u.cpf,dataHora:dh,votou:ST.jaVotou.includes(id)}:null;
      })
      .filter(Boolean)
      .sort((a,b)=>a.nome.localeCompare(b.nome));
    const hdr=[
      {v:'#',bold:true,bg:'4472C4'},{v:'Nome Completo',bold:true,bg:'4472C4'},
      {v:'CPF',bold:true,bg:'4472C4'},{v:'Data/Hora Check-in',bold:true,bg:'4472C4'},
      {v:'Votou?',bold:true,bg:'4472C4'},
    ];
    const buf=buildXLSX([{name:'Presença',rows:[hdr,...rows.map((r,i)=>[i+1,r.nome,r.cpf,fmtDataHora(r.dataHora),r.votou?'Sim':'Não'])]}]);
    return sendXLSX(res,buf,'lista-presenca.xlsx');
  }

  // Membros
  if(m==='GET'&&pn==='/api/usuarios/exportar'){
    const csv=toCSV(ST.users,['nome','cpf']);
    res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="membros.csv"'});
    return res.end('\uFEFF'+csv);
  }
  if(m==='POST'&&pn==='/api/usuarios/importar'){
    const body=await jsonBody(req);const rows=parseCSV(typeof body==='string'?body:body.csv||'');
    const result=importarMembros(rows);saveState(ST);return sendJSON(res,{ok:true,...result});
  }
  if(m==='POST'&&pn==='/api/usuarios/importar-xlsx'){
    const ct=req.headers['content-type']||'',bm=ct.match(/boundary=([^\s;]+)/);
    if(!bm)return sendJSON(res,{error:'Content-Type inválido.'},400);
    const parts=parseMultipart(await rawBody(req),bm[1]);
    const file=parts['file']||parts['xlsx']||parts['arquivo'];
    if(!file?.data)return sendJSON(res,{error:'Arquivo não enviado.'},400);
    const parsed=readXLSX(file.data);
    if(parsed.error)return sendJSON(res,{error:parsed.error},400);
    const result=importarMembros(parsed.rows);saveState(ST);return sendJSON(res,{ok:true,...result,erros:result.erros});
  }
  if(m==='POST'&&pn==='/api/usuarios'){
    const{nome,cpf}=await jsonBody(req);
    if(!nome||!cpf)return sendJSON(res,{error:'Nome e CPF obrigatórios.'},400);
    const cpfLimpo=cpf.replace(/\D/g,'');
    if(!validCPF(cpfLimpo))return sendJSON(res,{error:'CPF inválido.'},400);
    const cpfFmt=fmtCPF(cpfLimpo);
    if(ST.users.find(u=>u.cpf===cpfFmt))return sendJSON(res,{error:'CPF já cadastrado.'},409);
    const u={id:genId(),nome:nome.trim(),cpf:cpfFmt};ST.users.push(u);saveState(ST);
    return sendJSON(res,{ok:true,user:u});
  }
  if(m==='PATCH'&&pn.startsWith('/api/usuarios/')){
    const id=pn.split('/')[3],u=ST.users.find(x=>x.id===id);
    if(!u)return sendJSON(res,{error:'Membro não encontrado.'},404);
    const b=await jsonBody(req);
    if(b.nome)u.nome=b.nome.trim();
    if(b.cpf&&b.cpf!==u.cpf){
      const cl=b.cpf.replace(/\D/g,'');
      if(!validCPF(cl))return sendJSON(res,{error:'CPF inválido.'},400);
      const cf=fmtCPF(cl);
      if(ST.users.find(x=>x.cpf===cf&&x.id!==id))return sendJSON(res,{error:'CPF já em uso.'},409);
      u.cpf=cf;
    }
    saveState(ST);return sendJSON(res,{ok:true,user:u});
  }
  if(m==='DELETE'&&pn.startsWith('/api/usuarios/')){
    const id=pn.split('/')[3];
    ST.users=ST.users.filter(u=>u.id!==id);
    presRemove(ST.presentes,id);
    ST.jaVotou=ST.jaVotou.filter(x=>x!==id);ST.candidatos=ST.candidatos.filter(c=>c.userId!==id);
    saveState(ST);return sendJSON(res,{ok:true});
  }

  // Candidatos — sem campo desc na criação
  if(m==='POST'&&pn==='/api/candidatos'){
    const{userId,idade}=await jsonBody(req);
    if(!userId)return sendJSON(res,{error:'userId obrigatório.'},400);
    const u=ST.users.find(x=>x.id===userId);
    if(!u)return sendJSON(res,{error:'Membro não encontrado.'},404);
    if(ST.candidatos.find(c=>c.userId===userId))return sendJSON(res,{error:'Este membro já é candidato.'},409);
    const c={id:genId(),userId,nome:u.nome,idade:Number(idade)||0,fotoUrl:''};
    ST.candidatos.push(c);saveState(ST);return sendJSON(res,{ok:true,candidato:c});
  }
  if(m==='PATCH'&&pn.match(/^\/api\/candidatos\/[^/]+$/)&&!pn.includes('/foto')){
    const id=pn.split('/')[3],c=ST.candidatos.find(x=>x.id===id);
    if(!c)return sendJSON(res,{error:'Candidato não encontrado.'},404);
    const b=await jsonBody(req);
    if(b.idade!==undefined)c.idade=Number(b.idade);
    saveState(ST);return sendJSON(res,{ok:true,candidato:c});
  }
  if(m==='DELETE'&&pn.startsWith('/api/candidatos/')&&!pn.includes('/foto')){
    const id=pn.split('/')[3],c=ST.candidatos.find(x=>x.id===id);
    if(c?.fotoUrl){const fp=path.join(__dirname,'public',c.fotoUrl);if(fs.existsSync(fp))fs.unlinkSync(fp);}
    ST.candidatos=ST.candidatos.filter(x=>x.id!==id);saveState(ST);return sendJSON(res,{ok:true});
  }
  if(m==='POST'&&pn.match(/^\/api\/candidatos\/[^/]+\/foto$/)){
    const id=pn.split('/')[3],c=ST.candidatos.find(x=>x.id===id);
    if(!c)return sendJSON(res,{error:'Candidato não encontrado.'},404);
    const ct=req.headers['content-type']||'',bm=ct.match(/boundary=([^\s;]+)/);
    if(!bm)return sendJSON(res,{error:'Content-Type inválido.'},400);
    const parts=parseMultipart(await rawBody(req),bm[1]),file=parts['foto'];
    if(!file?.filename)return sendJSON(res,{error:'Arquivo não enviado.'},400);
    const ext=safeExt(file.filename),fn='cand_'+id+ext;
    fs.writeFileSync(path.join(FOTOS_DIR,fn),file.data);
    c.fotoUrl='/fotos/'+fn;saveState(ST);return sendJSON(res,{ok:true,fotoUrl:c.fotoUrl});
  }

  // Cargos
  if(m==='POST'&&pn==='/api/cargos'){
    const{nome,vagas}=await jsonBody(req);
    if(!nome||!vagas)return sendJSON(res,{error:'Nome e vagas obrigatórios.'},400);
    ST.cargos.push({id:genId(),nome:nome.trim(),vagas:Number(vagas)});saveState(ST);return sendJSON(res,{ok:true});
  }
  if(m==='DELETE'&&pn.startsWith('/api/cargos/')){ST.cargos=ST.cargos.filter(g=>g.id!==pn.split('/')[3]);saveState(ST);return sendJSON(res,{ok:true});}

  // Eleição
  if(m==='POST'&&pn==='/api/eleicao/iniciar'){
    if(!ST.presentes.length)return sendJSON(res,{error:'Marque presença de pelo menos 1 membro.'},400);
    if(!ST.cargos.length)return sendJSON(res,{error:'Cadastre pelo menos 1 cargo.'},400);
    if(!ST.candidatos.length)return sendJSON(res,{error:'Cadastre pelo menos 1 candidato.'},400);
    ST.elStatus='ativa';saveState(ST);return sendJSON(res,{ok:true});
  }
  if(m==='POST'&&pn==='/api/eleicao/encerrar'){ST.elStatus='encerrada';saveState(ST);return sendJSON(res,{ok:true});}
  if(m==='POST'&&pn==='/api/eleicao/reiniciar'){ST.elStatus='aguardando';ST.resultados={};ST.jaVotou=[];saveState(ST);return sendJSON(res,{ok:true});}

  // Resultado XLSX
  if(m==='GET'&&pn==='/api/resultados/exportar-xlsx'){
    if(ST.elStatus!=='encerrada')return sendJSON(res,{error:'Eleição não encerrada.'},403);
    const ap=apurar(),sheets=[];
    sheets.push({name:'Resumo',rows:[
      [{v:APP_NAME+' v'+VERSION,bold:true,bg:'4472C4'},'',''],['','',''],
      [{v:'Total de membros',bold:true},ST.users.length,''],
      [{v:'Total de presentes',bold:true},ST.presentes.length,''],
      [{v:'Total de votantes',bold:true},ST.jaVotou.length,''],
      [{v:'Abstenções',bold:true},ST.presentes.length-ST.jaVotou.length,''],['','',''],
      ...ap.map(a=>[{v:a.cargo.nome,bold:true},a.eleitos.length+' eleito(s) de '+a.cargo.vagas+' vaga(s)','Maioria: '+a.maioria+' votos']),
    ]});
    for(const a of ap){
      const hdr=[[{v:'#',bold:true,bg:'4472C4'},{v:'Candidato',bold:true,bg:'4472C4'},{v:'Votos',bold:true,bg:'4472C4'},{v:'% dos presentes',bold:true,bg:'4472C4'},{v:'Situação',bold:true,bg:'4472C4'}]];
      const rows=a.rank.map((r,i)=>{
        const pct=a.total>0?(r.v/a.total*100).toFixed(1)+'%':'0%',el=a.eleitos.some(e=>e.cid===r.cid);
        return[i+1,el?{v:r.c.nome,bold:true,bg:'70AD47'}:r.c.nome,el?{v:r.v,bold:true,bg:'70AD47'}:r.v,el?{v:pct,bold:true,bg:'70AD47'}:pct,el?{v:'ELEITO ✓',bold:true,bg:'70AD47'}:(r.v>0?'Não eleito':'Sem votos')];
      });
      if(a.branco>0)rows.push(['—','Votos em branco / nulos',a.branco,'—','—']);
      sheets.push({name:a.cargo.nome.slice(0,31),rows:[...hdr,...rows]});
    }
    const pr=ST.presentes.map(p=>{
      const id=typeof p==='string'?p:p.id,dh=typeof p==='string'?null:p.dataHora;
      const u=ST.users.find(x=>x.id===id);
      return u?{nome:u.nome,cpf:u.cpf,dataHora:dh,votou:ST.jaVotou.includes(id)}:null;
    }).filter(Boolean).sort((a,b)=>a.nome.localeCompare(b.nome));
    sheets.push({name:'Lista de Presença',rows:[
      [{v:'#',bold:true,bg:'4472C4'},{v:'Nome',bold:true,bg:'4472C4'},{v:'CPF',bold:true,bg:'4472C4'},{v:'Data/Hora Check-in',bold:true,bg:'4472C4'},{v:'Votou?',bold:true,bg:'4472C4'}],
      ...pr.map((u,i)=>[i+1,u.nome,u.cpf,fmtDataHora(u.dataHora),u.votou?'Sim':'Não'])
    ]});
    return sendXLSX(res,buildXLSX(sheets),'resultado-eleicao.xlsx');
  }

  return sendJSON(res,{error:'Rota não encontrada.'},404);
});

function checkinPage() {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Check-in</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#f0ede6;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;padding:28px 24px;width:100%;max-width:360px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:22px;font-weight:700;margin-bottom:6px}
.sub{font-size:13px;color:#888;margin-bottom:22px;line-height:1.5}
label{font-size:12px;color:#666;display:block;margin-bottom:5px;font-weight:600}
input{width:100%;padding:12px 14px;border-radius:10px;border:1.5px solid #ddd;font-size:16px;outline:none;transition:border-color .15s;background:#fafaf8;font-family:inherit}
input:focus{border-color:var(--p,#185FA5)}
.btn{width:100%;margin-top:14px;padding:13px;border-radius:10px;border:none;font-size:15px;font-weight:700;cursor:pointer;background:var(--p,#185FA5);color:#fff;transition:opacity .15s}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-outline{background:#fff;color:var(--p,#185FA5);border:1.5px solid var(--p,#185FA5)}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:20px;z-index:100}
.modal{background:#fff;border-radius:16px;padding:24px;width:100%;max-width:340px}
.row{display:flex;gap:8px;padding:8px 0;border-bottom:1px solid #f0ede6}
.rl{font-size:11px;color:#aaa;min-width:52px;font-weight:600;text-transform:uppercase;padding-top:2px}
.rv{font-size:15px;font-weight:700}
.btn-row{display:flex;gap:10px;margin-top:18px}
.btn-row button{flex:1;padding:11px;border-radius:9px;font-size:14px;font-weight:700;cursor:pointer;border:none}
.bc{background:#f0ede6;color:#666}
.bg{background:var(--s,#3B6D11);color:#fff}
.err{background:#fcebeb;color:#a32d2d;border-radius:8px;padding:10px;font-size:13px;margin-top:10px}
.ok-msg{background:#eaf3de;color:#3B6D11;border-radius:8px;padding:10px;font-size:13px;margin-top:10px;font-weight:600}
#logo{max-height:60px;margin-bottom:12px}
.redirect-bar{height:4px;background:#eee;border-radius:2px;margin-top:16px;overflow:hidden}
.redirect-fill{height:100%;background:var(--s,#3B6D11);border-radius:2px;transition:width 3s linear}
</style>
</head><body>

<div id="tela-cpf">
  <div class="card">
    <div id="logo-wrap" style="text-align:center"></div>
    <div style="font-size:44px;text-align:center;margin-bottom:12px">🗳️</div>
    <h1 id="nome-inst">Check-in na Eleição</h1>
    <p class="sub">Digite seu CPF para confirmar sua presença.</p>
    <label>Seu CPF</label>
    <input id="cpf-in" type="text" inputmode="numeric" placeholder="000.000.000-00" maxlength="14" autocomplete="off">
    <div id="err" style="display:none"></div>
    <button class="btn" id="btn-ok" onclick="buscar()">Confirmar presença</button>
  </div>
</div>

<div class="overlay" id="modal" style="display:none">
  <div class="modal">
    <div style="font-size:36px;text-align:center;margin-bottom:12px">✅</div>
    <p style="font-weight:700;font-size:17px;margin-bottom:14px;text-align:center">Confirme seus dados</p>
    <div class="row"><span class="rl">Nome</span><span class="rv" id="m-nome"></span></div>
    <div class="row"><span class="rl">CPF</span><span class="rv" id="m-cpf"></span></div>

    <div id="m-err" class="err" style="display:none"></div>
    <div class="btn-row">
      <button class="bc" onclick="fechar()">Cancelar</button>
      <button class="bg" onclick="confirmar()">Confirmar ✓</button>
    </div>
  </div>
</div>

<div id="tela-ok" style="display:none;width:100%;max-width:360px">
  <div class="card" style="text-align:center">
    <div style="font-size:64px;margin-bottom:12px">🎉</div>
    <h1 id="ok-nome" style="margin-bottom:8px;font-size:20px"></h1>
    <p style="font-size:14px;color:#666;line-height:1.7">Presença confirmada com sucesso!<br>Redirecionando para a votação...</p>
    <div class="redirect-bar"><div class="redirect-fill" id="redirect-fill" style="width:0%"></div></div>
    <button class="btn btn-outline" style="margin-top:14px;font-size:13px" onclick="window.location.href='/votar'">Ir para votação agora →</button>
  </div>
</div>

<script>
(async()=>{
  const c=await(await fetch('/api/config')).json();
  document.body.style.background=c.corFundo||'#f0ede6';
  document.documentElement.style.setProperty('--p',c.corPrimaria||'#185FA5');
  document.documentElement.style.setProperty('--s',c.corSecundaria||'#3B6D11');
  if(c.logoUrl) document.getElementById('logo-wrap').innerHTML='<img id="logo" src="'+c.logoUrl+'">';
  document.getElementById('nome-inst').textContent='Check-in — '+(c.nomeInstituicao||'Eleição');
  // Pre-fill CPF se veio da página de cadastro
  const urlCPF=new URLSearchParams(window.location.search).get('cpf');
  if(urlCPF){
    const inp=document.getElementById('cpf-in');
    if(inp){inp.value=urlCPF;window.history.replaceState({},'','/checkin');}
  }
})();

const fmt=v=>v.replace(/\\D/g,'').replace(/(\\d{3})(\\d{3})(\\d{3})(\\d{2})/,'$1.$2.$3-$4').slice(0,14);
const inp=document.getElementById('cpf-in');
inp.addEventListener('input',e=>e.target.value=fmt(e.target.value));
inp.addEventListener('keydown',e=>{if(e.key==='Enter')buscar();});
let _cpf='';

async function buscar(){
  const cpf=inp.value.trim();
  const err=document.getElementById('err');
  err.style.display='none';
  if(cpf.replace(/\\D/g,'').length<11){
    err.className='err'; err.textContent='Digite um CPF válido com 11 dígitos.'; err.style.display='block'; return;
  }
  const btn=document.getElementById('btn-ok');
  btn.disabled=true; btn.textContent='Buscando...';
  try{
    const r=await fetch('/api/checkin/buscar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cpf})});
    const d=await r.json();
    btn.disabled=false; btn.textContent='Confirmar presença';
    if(d.naoEncontrado){
      // CPF não cadastrado → redireciona para página de cadastro
      window.location.href='/cadastro?cpf='+encodeURIComponent(cpf);
      return;
    }
    if(d.error){ err.className='err'; err.textContent=d.error; err.style.display='block'; return; }
    if(d.jaPresente){
      err.className='ok-msg';
      err.textContent='✓ Você já está registrado como presente!';
      err.style.display='block';
      // Já presente — redireciona direto para votação após 2s
      setTimeout(()=>window.location.href='/votar?cpf='+encodeURIComponent(cpf), 2000);
      return;
    }
    _cpf=cpf;
    document.getElementById('m-nome').textContent=d.user.nome;
    document.getElementById('m-cpf').textContent=d.user.cpf;
    
    document.getElementById('modal').style.display='flex';
  }catch(e){
    btn.disabled=false; btn.textContent='Confirmar presença';
    err.className='err'; err.textContent='Erro de conexão. Verifique a rede e tente novamente.'; err.style.display='block';
  }
}

function fechar(){ document.getElementById('modal').style.display='none'; }

async function confirmar(){
  const me=document.getElementById('m-err'); me.style.display='none';
  const r=await fetch('/api/checkin/confirmar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cpf:_cpf})});
  const d=await r.json();
  if(d.error){ me.textContent=d.error; me.style.display='block'; return; }
  // Sucesso — fecha modal, mostra tela OK e redireciona
  document.getElementById('modal').style.display='none';
  document.getElementById('tela-cpf').style.display='none';
  document.getElementById('ok-nome').textContent=d.user.nome+'!';
  const tela=document.getElementById('tela-ok');
  tela.style.display='block';
  // Anima barra e redireciona em 3s
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      document.getElementById('redirect-fill').style.width='100%';
    });
  });
  // Redirect to /votar with cpf pre-filled so it auto-logs in
  setTimeout(()=>window.location.href='/votar?cpf='+encodeURIComponent(_cpf), 3000);
}
</script>
</body></html>`;
}

function votarPage() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Votação</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg,#f0ede6);color:var(--tx,#1a1a18);min-height:100vh}
.page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.wrap{width:100%;max-width:380px}
.box{background:#fff;border:1px solid #ddd;border-radius:14px;padding:20px}
.big-box{max-width:520px;width:100%;margin:0 auto}
.input{width:100%;padding:11px 13px;border-radius:8px;border:1.5px solid #ccc;font-size:16px;outline:none;font-family:inherit;background:#fff;color:inherit}
.input:focus{border-color:var(--p,#185FA5)}
.btn{display:flex;align-items:center;justify-content:center;padding:12px 16px;border-radius:10px;font-size:15px;font-weight:700;border:none;cursor:pointer;width:100%;margin-top:12px;font-family:inherit}
.btn-p{background:var(--p,#185FA5);color:#fff}
.btn-p:disabled{opacity:.5;cursor:not-allowed}
.btn-s{background:var(--s,#3B6D11);color:#fff}
.btn-back{background:#f0ede6;color:#555;font-size:13px;max-width:110px}
.err{background:#fcebeb;color:#a32d2d;font-size:13px;padding:9px 12px;border-radius:8px;margin-top:10px}
/* candidato */
.cand{background:#fff;border:1.5px solid #ddd;border-radius:12px;padding:13px;margin-bottom:9px;cursor:pointer;display:flex;align-items:center;gap:13px}
.cand.sel{border-color:var(--p,#185FA5);background:rgba(24,95,165,.08)}
.check{width:24px;height:24px;border-radius:50%;border:1.5px solid #ccc;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:13px;font-weight:700;color:#fff}
.check.on{background:var(--p,#185FA5);border-color:var(--p,#185FA5)}
.foto{border-radius:50%;object-fit:cover;flex-shrink:0}
.emj{border-radius:50%;background:#f0ede6;display:flex;align-items:center;justify-content:center;flex-shrink:0}
/* user strip */
.user-strip{background:#fff;border:1px solid #e0e0dc;border-radius:10px;padding:9px 13px;display:flex;align-items:center;gap:10px;margin-bottom:12px}
.ua{width:36px;height:36px;border-radius:50%;background:var(--p,#185FA5);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;color:#fff;flex-shrink:0}
/* dot steps */
.dot{width:9px;height:9px;border-radius:50%;background:#ccc}
.dot.on{background:var(--p,#185FA5)}.dot.done{background:var(--s,#3B6D11)}
/* espera */
.espera-icon{font-size:60px;display:block;text-align:center;margin-bottom:14px;animation:bob 2.5s ease-in-out infinite}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
.dl-row{display:flex;justify-content:center;gap:7px;margin:16px 0}
.dl{width:9px;height:9px;border-radius:50%;background:var(--p,#185FA5);animation:dl 1.4s ease-in-out infinite}
.dl:nth-child(2){animation-delay:.2s}.dl:nth-child(3){animation-delay:.4s}
@keyframes dl{0%,80%,100%{opacity:.2;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}
/* modal */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px;z-index:50}
</style>
</head>
<body>
<div id="root">
  <div class="page"><div class="dl-row"><div class="dl"></div><div class="dl"></div><div class="dl"></div></div></div>
</div>

<script>
// ─────────────────────────────────────────────
// Estado global — persiste enquanto a página não recarregar
// ─────────────────────────────────────────────
const App = {
  cfg:   {},
  cands: [],
  cargos:[],
  user:  null,   // { id, nome, cpf, email }
  votos: {},     // { cargoId: [candId, ...] }
  step:  0,
  tela:  'login' // login | espera | voto | confirmar | fim | encerrada
};

// ─────────────────────────────────────────────
// Utilitários
// ─────────────────────────────────────────────
const R = id => document.getElementById(id);
const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function fmtCPF(v) {
  var d = v.replace(/[^0-9]/g, '');
  if (d.length > 3)  d = d.slice(0,3) + '.' + d.slice(3);
  if (d.length > 7)  d = d.slice(0,7) + '.' + d.slice(7);
  if (d.length > 11) d = d.slice(0,11) + '-' + d.slice(11);
  return d.slice(0,14);
}
function applyTheme(c) {
  var p = c.corPrimaria || '#185FA5';
  var s = c.corSecundaria || '#3B6D11';
  var bg = c.corFundo || '#f0ede6';
  document.documentElement.style.setProperty('--p', p);
  document.documentElement.style.setProperty('--s', s);
  document.documentElement.style.setProperty('--bg', bg);
  document.body.style.background = bg;
  document.title = (c.nomeInstituicao || 'Eleição') + ' — Votação';
}
function imgErr(el) {
  el.style.display = 'none';
  if (el.nextElementSibling) el.nextElementSibling.style.display = 'flex';
}
function av(c, sz) {
  if (!c) return '';
  var fsz = Math.round(sz * 0.45);
  if (c.fotoUrl)
    return '<img src="' + esc(c.fotoUrl) + '" class="foto" width="' + sz + '" height="' + sz + '" onerror="imgErr(this)">'
      + '<div class="emj" style="width:' + sz + 'px;height:' + sz + 'px;font-size:' + fsz + 'px;display:none">' + esc(c.emoji||'😊') + '</div>';
  return '<div class="emj" style="width:' + sz + 'px;height:' + sz + 'px;font-size:' + fsz + 'px">' + esc(c.emoji||'😊') + '</div>';
}

// ─────────────────────────────────────────────
// Render principal — chama a função da tela certa
// ─────────────────────────────────────────────
function render() {
  var t = App.tela;
  if (t === 'login')     return telaLogin();
  if (t === 'espera')    return telaEspera();
  if (t === 'voto')      return telaVoto();
  if (t === 'confirmar') return telaConfirmar();
  if (t === 'fim')       return telaFim();
  if (t === 'encerrada') return telaEncerrada();
}

// ─────────────────────────────────────────────
// TELA: Login
// ─────────────────────────────────────────────
function telaLogin() {
  var c = App.cfg;
  var logo = c.logoUrl
    ? '<img src="' + esc(c.logoUrl) + '" style="max-height:56px;margin-bottom:14px;display:block;margin-left:auto;margin-right:auto">'
    : '<div style="font-size:52px;text-align:center;margin-bottom:10px">🗳️</div>';
  R('root').innerHTML =
    '<div class="page"><div class="wrap">'
    + '<div style="text-align:center;margin-bottom:20px">' + logo
    + '<h1 style="font-size:21px;font-weight:700">' + esc(c.nomeInstituicao||'Eleição') + '</h1>'
    + '<p style="font-size:13px;color:#888;margin-top:5px">Digite seu CPF para votar</p></div>'
    + '<div class="box">'
    + '<label style="font-size:12px;color:#666;display:block;margin-bottom:6px;font-weight:600">Seu CPF</label>'
    + '<input id="cpf-in" class="input" placeholder="000.000.000-00" inputmode="numeric" maxlength="14" autocomplete="off" spellcheck="false">'
    + '<div id="login-err" class="err" style="display:none"></div>'
    + '<button id="btn-login" class="btn btn-p" onclick="acaoLogin()">Entrar para votar</button>'
    + '</div></div></div>';
  var inp = R('cpf-in');
  if (inp) {
    inp.addEventListener('input', function(e){ e.target.value = fmtCPF(e.target.value); });
    inp.addEventListener('keydown', function(e){ if (e.key === 'Enter') acaoLogin(); });
    inp.focus();
  }
}

async function acaoLogin() {
  var cpf = (R('cpf-in').value || '').trim();
  var errEl = R('login-err');
  errEl.style.display = 'none';
  if (cpf.replace(/[^0-9]/g,'').length < 11) {
    errEl.textContent = 'Digite o CPF completo (11 dígitos).';
    errEl.style.display = 'block'; return;
  }
  var btn = R('btn-login');
  btn.disabled = true; btn.textContent = 'Aguarde...';
  try {
    var r = await fetch('/api/login-eleitor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cpf: cpf })
    });
    var d = await r.json();
    btn.disabled = false; btn.textContent = 'Entrar para votar';
    if (d.error) { errEl.textContent = d.error; errEl.style.display = 'block'; return; }
    App.user  = d.user;
    App.votos = {};
    App.step  = 0;
    // Decide tela pelo status que o servidor devolveu
    if (d.elStatus === 'ativa')      { App.tela = 'voto';      render(); }
    else if (d.elStatus === 'encerrada') { App.tela = 'encerrada'; render(); }
    else                             { App.tela = 'espera';    render(); }
  } catch(e) {
    btn.disabled = false; btn.textContent = 'Entrar para votar';
    errEl.textContent = 'Erro de conexão. Verifique a rede e tente novamente.';
    errEl.style.display = 'block';
  }
}

// ─────────────────────────────────────────────
// TELA: Aguardando início  ← ABORDAGEM NOVA
// Não usa setInterval. Usa setTimeout com função nomeada
// que verifica e chama a si mesma novamente.
// ─────────────────────────────────────────────
var _esperaTimer = null;

function telaEspera() {
  // Para qualquer poll anterior
  if (_esperaTimer) { clearTimeout(_esperaTimer); _esperaTimer = null; }

  R('root').innerHTML =
    '<div class="page"><div class="wrap">'
    + (App.cfg.logoUrl ? '<div style="text-align:center;margin-bottom:12px"><img src="' + esc(App.cfg.logoUrl) + '" style="max-height:44px"></div>' : '')
    + '<div class="box" style="text-align:center;padding:32px 24px">'
    + '<span class="espera-icon">⏳</span>'
    + '<h2 style="font-size:19px;font-weight:700;margin-bottom:8px">Aguardando início</h2>'
    + '<p style="font-size:14px;color:#555;line-height:1.7">'
    + 'Olá, <strong>' + esc(App.user.nome) + '</strong>!<br>'
    + 'Sua presença está confirmada.<br>'
    + 'A votação ainda não foi iniciada.</p>'
    + '<div class="dl-row"><div class="dl"></div><div class="dl"></div><div class="dl"></div></div>'
    + '<p style="font-size:12px;color:#bbb">Esta página verifica automaticamente<br>quando a votação começar.</p>'
    + '<p id="ts" style="font-size:11px;color:#ccc;margin-top:8px">&nbsp;</p>'
    + '</div></div></div>';

  // Inicia o loop de verificação
  verificarStatus();
}

async function verificarStatus() {
  // Cancela timer anterior se existir
  if (_esperaTimer) { clearTimeout(_esperaTimer); _esperaTimer = null; }

  // Atualiza timestamp na tela
  var ts = R('ts');
  if (ts) ts.textContent = 'Verificado às ' + new Date().toLocaleTimeString('pt-BR');

  try {
    var r = await fetch('/api/state');
    var d = await r.json();

    // Atualiza candidatos e cargos (podem ter mudado)
    App.cands  = d.candidatos || [];
    App.cargos = d.cargos || [];

    var status = d.elStatus || 'aguardando';

    if (status === 'ativa') {
      // Eleição começou! Vai direto para votação
      App.tela = 'voto';
      render();
      return; // Para o loop
    }

    if (status === 'encerrada') {
      App.tela = 'encerrada';
      render();
      return; // Para o loop
    }

    // Ainda aguardando: agenda próxima verificação em 3 segundos
    _esperaTimer = setTimeout(verificarStatus, 3000);

  } catch(e) {
    // Erro de rede: tenta novamente em 5 segundos
    var ts2 = R('ts');
    if (ts2) ts2.textContent = 'Erro de conexão — tentando novamente...';
    _esperaTimer = setTimeout(verificarStatus, 5000);
  }
}

// ─────────────────────────────────────────────
// TELA: Votação
// ─────────────────────────────────────────────
function telaVoto() {
  var cargo = App.cargos[App.step];
  if (!cargo) { App.tela = 'confirmar'; render(); return; }
  var sel = App.votos[cargo.id] || [];
  var dots = App.cargos.map(function(_, i) {
    var cls = i === App.step ? 'on' : (i < App.step ? 'done' : '');
    return '<div class="dot ' + cls + '" style="width:9px;height:9px"></div>';
  }).join('');

  var cands = App.cands.map(function(c) {
    var s = sel.indexOf(c.id) >= 0;
    return '<div class="cand ' + (s?'sel':'') + '" onclick="toggleCand('' + c.id + '',' + cargo.vagas + ')">'
      + av(c, 60)
      + '<div style="flex:1;min-width:0">'
      + '<p style="font-weight:700;font-size:14px;color:' + (s?'var(--p)':'inherit') + '">' + esc(c.nome) + '</p>'
      + '<p style="font-size:12px;color:#888;margin-top:2px">' + c.idade + ' anos</p>'
      + '<p style="font-size:11px;color:#aaa;margin-top:3px;line-height:1.4">' + esc(c.desc) + '</p>'
      + '</div>'
      + '<div class="check ' + (s?'on':'') + '">' + (s?'✓':'') + '</div>'
      + '</div>';
  }).join('');

  var navBtn = App.step < App.cargos.length - 1
    ? '<button class="btn btn-p" style="flex:1" onclick="proximoCargo()">Próximo →</button>'
    : '<button class="btn btn-s" style="flex:1" onclick="App.tela='confirmar';render()">Confirmar voto ✓</button>';

  R('root').innerHTML =
    '<div style="min-height:100vh;padding:14px">'
    + '<div class="big-box">'
    // Topo: logo + dots
    + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">'
    + (App.cfg.logoUrl ? '<img src="' + esc(App.cfg.logoUrl) + '" style="height:28px;flex-shrink:0">' : '<span style="font-size:20px">🗳️</span>')
    + '<div style="flex:1"></div>'
    + '<div style="display:flex;gap:4px">' + dots + '</div>'
    + '</div>'
    // Identificação do eleitor
    + '<div class="user-strip">'
    + '<div class="ua">' + esc((App.user.nome||'?')[0].toUpperCase()) + '</div>'
    + '<div style="flex:1;min-width:0">'
    + '<p style="font-size:13px;font-weight:700;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(App.user.nome) + '</p>'
    + '<p style="font-size:11px;color:#888;margin-top:1px">CPF: ' + esc(App.user.cpf) + '</p>'
    + '</div>'
    + '<span style="font-size:10px;color:#bbb;font-weight:600;text-transform:uppercase;letter-spacing:.3px;flex-shrink:0">Identificado ✓</span>'
    + '</div>'
    // Cargo
    + '<div class="box" style="margin-bottom:10px">'
    + '<p style="font-size:10px;color:#aaa;font-weight:700;text-transform:uppercase;letter-spacing:.5px">Cargo ' + (App.step+1) + ' de ' + App.cargos.length + '</p>'
    + '<h2 style="font-size:19px;font-weight:700;margin-top:3px;margin-bottom:6px">' + esc(cargo.nome) + '</h2>'
    + '<p style="font-size:13px;color:#666">Selecione até <strong>' + cargo.vagas + '</strong> candidato' + (cargo.vagas>1?'s':'')
    + ' <span style="font-weight:700;color:' + (sel.length===cargo.vagas?'var(--s)':'var(--p)') + '">' + sel.length + '/' + cargo.vagas + '</span></p>'
    + (sel.length < cargo.vagas ? '<p style="font-size:11px;color:#aaa;margin-top:4px">' + (cargo.vagas-sel.length) + ' voto(s) restante(s) contarão como branco.</p>' : '')
    + '</div>'
    // Candidatos
    + cands
    // Navegação
    + '<div style="display:flex;gap:8px;margin-top:4px">'
    + (App.step > 0 ? '<button class="btn btn-back" onclick="App.step--;render()">← Anterior</button>' : '')
    + navBtn
    + '</div>'
    + '</div></div>';
}

function toggleCand(candId, vagas) {
  var cargo = App.cargos[App.step];
  if (!cargo) return;
  var sel = (App.votos[cargo.id] || []).slice();
  var i = sel.indexOf(candId);
  if (i >= 0) sel.splice(i, 1);
  else if (sel.length < vagas) sel.push(candId);
  App.votos[cargo.id] = sel;
  render();
}

function proximoCargo() {
  App.step++;
  render();
}

// ─────────────────────────────────────────────
// TELA: Confirmação
// ─────────────────────────────────────────────
function telaConfirmar() {
  var resumo = App.cargos.map(function(g) {
    var sv = App.votos[g.id] || [];
    var itens = sv.length > 0
      ? sv.map(function(cid) {
          var c = App.cands.find(function(x){ return x.id === cid; });
          return '<div style="display:flex;align-items:center;gap:9px;margin-top:5px">' + av(c,38) + '<p style="font-size:14px;font-weight:700">' + esc(c?c.nome:'') + '</p></div>';
        }).join('')
      : '<p style="font-size:13px;color:#aaa;font-style:italic">Voto em branco</p>';
    var extra = sv.length > 0 && sv.length < g.vagas
      ? '<p style="font-size:11px;color:#aaa;margin-top:3px">' + (g.vagas-sv.length) + ' voto(s) em branco</p>' : '';
    return '<div style="margin-bottom:14px">'
      + '<p style="font-size:10px;color:#aaa;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">' + esc(g.nome) + '</p>'
      + itens + extra + '</div>';
  }).join('');

  R('root').innerHTML =
    '<div class="page"><div class="wrap">'
    + '<div class="box">'
    + '<h3 style="font-weight:700;font-size:17px;margin-bottom:4px">Confirmar voto?</h3>'
    + '<p style="font-size:13px;color:#888;margin-bottom:14px">Após confirmar não é possível alterar.</p>'
    + '<div style="background:#f8f8f6;border-radius:8px;padding:8px 12px;margin-bottom:14px;font-size:12px">'
    + '<span style="font-weight:700">' + esc(App.user.nome) + '</span>'
    + ' &nbsp;·&nbsp; CPF: ' + esc(App.user.cpf) + '</div>'
    + resumo
    + '<hr style="border:none;border-top:1px solid #eee;margin:12px 0">'
    + '<div style="display:flex;gap:8px">'
    + '<button class="btn btn-back" style="max-width:none;flex:1" onclick="App.step=App.cargos.length-1;App.tela='voto';render()">Revisar</button>'
    + '<button id="btn-conf" class="btn btn-s" style="flex:1" onclick="acaoConfirmar()">Confirmar ✓</button>'
    + '</div></div></div></div>';
}

async function acaoConfirmar() {
  var btn = R('btn-conf');
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }
  try {
    var r = await fetch('/api/votar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: App.user.id, votos: App.votos })
    });
    var d = await r.json();
    if (d.error) {
      if (btn) { btn.disabled = false; btn.textContent = 'Confirmar ✓'; }
      alert('Erro: ' + d.error); return;
    }
    App.tela = 'fim'; render();
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Confirmar ✓'; }
    alert('Erro de conexão ao registrar voto. Tente novamente.');
  }
}

// ─────────────────────────────────────────────
// TELA: Voto registrado
// ─────────────────────────────────────────────
function telaFim() {
  R('root').innerHTML =
    '<div class="page"><div class="wrap">'
    + '<div class="box" style="text-align:center;padding:36px 24px">'
    + '<div style="font-size:68px;margin-bottom:14px">🎉</div>'
    + '<h2 style="font-weight:700;font-size:20px;margin-bottom:8px">Voto registrado!</h2>'
    + '<p style="font-size:14px;color:#666;line-height:1.65;margin-bottom:22px">'
    + 'Obrigado, <strong>' + esc(App.user.nome) + '</strong>.<br>'
    + 'Seu voto foi computado com sucesso.</p>'
    + '<button class="btn btn-p" onclick="App.user=null;App.tela='login';render()">Voltar ao início</button>'
    + '</div></div></div>';
}

// ─────────────────────────────────────────────
// TELA: Eleição encerrada
// ─────────────────────────────────────────────
function telaEncerrada() {
  R('root').innerHTML =
    '<div class="page"><div class="wrap">'
    + '<div class="box" style="text-align:center;padding:36px 24px">'
    + '<div style="font-size:52px;margin-bottom:14px">🔒</div>'
    + '<h2 style="font-size:18px;font-weight:700;margin-bottom:8px">Eleição encerrada</h2>'
    + '<p style="font-size:14px;color:#888;line-height:1.6">Os resultados estão disponíveis<br>no painel administrativo.</p>'
    + '<button class="btn btn-p" style="margin-top:20px" onclick="App.user=null;App.tela='login';render()">Voltar</button>'
    + '</div></div></div>';
}

// ─────────────────────────────────────────────
// Funções auxiliares para onclick (evitar aspas aninhadas no HTML)
// ─────────────────────────────────────────────
function irConfirmar()  { App.tela = 'confirmar'; render(); }
function voltarVoto()   { App.step = App.cargos.length - 1; App.tela = 'voto'; render(); }
function voltarLogin()  { App.user = null; App.tela = 'login'; render(); }


// ─────────────────────────────────────────────
// Boot: carrega config e candidatos, depois renderiza
// ─────────────────────────────────────────────
(async function boot() {
  try {
    var d = await (await fetch('/api/state')).json();
    App.cfg    = d.config     || {};
    App.cands  = d.candidatos || [];
    App.cargos = d.cargos     || [];
    applyTheme(App.cfg);
  } catch(e) {}
  render();
})();
</script>
</body>
</html>`;
}

function cadastroPage() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cadastro de Membro</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg,#f0ede6);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;padding:28px 24px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:21px;font-weight:700;margin-bottom:6px}
.sub{font-size:13px;color:#888;margin-bottom:22px;line-height:1.5}
label{font-size:12px;color:#666;display:block;margin-bottom:5px;font-weight:600}
input{width:100%;padding:12px 14px;border-radius:10px;border:1.5px solid #ddd;font-size:16px;outline:none;transition:border-color .15s;background:#fafaf8;font-family:inherit}
input:focus{border-color:var(--p,#185FA5)}
.btn{width:100%;margin-top:14px;padding:13px;border-radius:10px;border:none;font-size:15px;font-weight:700;cursor:pointer;background:var(--p,#185FA5);color:#fff;transition:opacity .15s}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-sec{background:transparent;color:var(--p,#185FA5);border:1.5px solid var(--p,#185FA5);margin-top:10px}
.err{background:#fcebeb;color:#a32d2d;border-radius:8px;padding:10px;font-size:13px;margin-top:10px}
.ok-msg{background:#eaf3de;color:#3B6D11;border-radius:8px;padding:10px;font-size:13px;margin-top:10px;font-weight:600}
.info{background:#e6f1fb;color:#185FA5;border-radius:8px;padding:10px;font-size:12px;margin-bottom:14px}
.cpf-field{position:relative}
</style>
</head>
<body>
<div class="card">
  <div id="logo-wrap" style="text-align:center;margin-bottom:12px"></div>
  <div style="font-size:40px;text-align:center;margin-bottom:12px">📋</div>
  <h1>Cadastro de Membro</h1>
  <p class="sub">Seu CPF não foi encontrado no sistema. Preencha os dados abaixo para se cadastrar.</p>
  <div class="info">Após o cadastro, você será redirecionado ao check-in para confirmar sua presença.</div>
  <div class="field" style="margin-bottom:12px">
    <label>Nome completo</label>
    <input id="inp-nome" type="text" placeholder="Seu nome completo" autocomplete="name" spellcheck="false">
  </div>
  <div class="field">
    <label>CPF</label>
    <input id="inp-cpf" type="text" inputmode="numeric" placeholder="000.000.000-00" maxlength="14" autocomplete="off">
  </div>
  <div id="msg" style="display:none"></div>
  <button class="btn" id="btn-cad" onclick="cadastrar()">Cadastrar e ir para check-in</button>
  <button class="btn btn-sec" onclick="window.location.href='/checkin'">← Voltar ao check-in</button>
</div>

<script>
(async()=>{
  const c=await(await fetch('/api/config')).json();
  document.body.style.background=c.corFundo||'#f0ede6';
  document.documentElement.style.setProperty('--p',c.corPrimaria||'#185FA5');
  if(c.logoUrl) document.getElementById('logo-wrap').innerHTML='<img src="'+c.logoUrl+'" style="max-height:50px">';
})();

// Pre-fill CPF from query param (vindo do check-in)
const urlCPF = new URLSearchParams(window.location.search).get('cpf');
if(urlCPF) {
  document.getElementById('inp-cpf').value = urlCPF;
}

function fmtCPF(v){
  var d=v.replace(/\D/g,'');
  if(d.length>9)  d=d.slice(0,3)+'.'+d.slice(3,6)+'.'+d.slice(6,9)+'-'+d.slice(9);
  else if(d.length>6) d=d.slice(0,3)+'.'+d.slice(3,6)+'.'+d.slice(6);
  else if(d.length>3) d=d.slice(0,3)+'.'+d.slice(3);
  return d.slice(0,14);
}

var inp=document.getElementById('inp-cpf');
inp.addEventListener('input',function(e){e.target.value=fmtCPF(e.target.value);});
inp.addEventListener('keydown',function(e){if(e.key==='Enter')cadastrar();});
document.getElementById('inp-nome').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('inp-cpf').focus();});

async function cadastrar(){
  var nome=(document.getElementById('inp-nome').value||'').trim();
  var cpf=(document.getElementById('inp-cpf').value||'').trim();
  var msg=document.getElementById('msg');
  msg.style.display='none';

  if(!nome){msg.className='err';msg.textContent='Digite seu nome completo.';msg.style.display='block';return;}
  if(cpf.replace(/\D/g,'').length<11){msg.className='err';msg.textContent='Digite o CPF completo (11 dígitos).';msg.style.display='block';return;}

  var btn=document.getElementById('btn-cad');
  btn.disabled=true; btn.textContent='Cadastrando...';

  try{
    var r=await fetch('/api/cadastro-publico',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({nome:nome,cpf:cpf})
    });
    var d=await r.json();
    btn.disabled=false; btn.textContent='Cadastrar e ir para check-in';

    if(d.error){
      msg.className='err'; msg.textContent=d.error; msg.style.display='block';
      return;
    }

    // Sucesso — mostra mensagem e redireciona para check-in com CPF preenchido
    msg.className='ok-msg';
    msg.textContent='✓ Cadastro realizado com sucesso, '+d.user.nome+'! Redirecionando para o check-in...';
    msg.style.display='block';
    btn.style.display='none';
    setTimeout(function(){
      window.location.href='/checkin?cpf='+encodeURIComponent(d.user.cpf);
    }, 2000);

  }catch(e){
    btn.disabled=false; btn.textContent='Cadastrar e ir para check-in';
    msg.className='err'; msg.textContent='Erro de conexão. Tente novamente.'; msg.style.display='block';
  }
}
</script>
</body>
</html>`;
}


function datashowPage() {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Painel — Eleição</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f1923;color:#fff;min-height:100vh;padding:28px 32px}
h1{font-size:30px;font-weight:900;letter-spacing:-1px;margin-bottom:2px}
.sub{font-size:13px;color:#5a7a96;margin-bottom:24px}
.topbar{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:24px}
.badge{display:inline-flex;align-items:center;gap:7px;padding:7px 16px;border-radius:100px;font-size:13px;font-weight:700}
.b-ativa{background:rgba(74,222,128,.12);color:#4ade80;border:1px solid rgba(74,222,128,.25)}
.b-agd{background:rgba(90,122,150,.12);color:#7aa3c0;border:1px solid rgba(90,122,150,.2)}
.b-enc{background:rgba(251,191,36,.12);color:#fbbf24;border:1px solid rgba(251,191,36,.2)}
.dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.dl{background:#4ade80;animation:pulse 1.5s infinite}
.dy{background:#fbbf24}
.dg{background:#7aa3c0}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
.stat{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:16px 20px}
.slbl{font-size:11px;color:#5a7a96;text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px;font-weight:600}
.sval{font-size:44px;font-weight:900;line-height:1}
.cb{color:#60a5fa}.cg{color:#4ade80}.ca{color:#fbbf24}
.prog-wrap{background:rgba(255,255,255,.07);border-radius:100px;height:12px;overflow:hidden;margin-bottom:6px}
.prog-fill{height:100%;border-radius:100px;background:linear-gradient(90deg,#185FA5,#4ade80);transition:width 1.2s ease}
.prog-lbl{font-size:13px;color:#5a7a96;margin-bottom:20px}
.slbl2{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#5a7a96;font-weight:700;margin-bottom:10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-bottom:20px}
.nv{background:rgba(251,191,36,.07);border:1px solid rgba(251,191,36,.18);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:8px}
.nvd{width:7px;height:7px;border-radius:50%;background:#fbbf24;flex-shrink:0;animation:pulse 2s infinite}
.nvn{font-size:13px;font-weight:600;color:#fde68a}
/* Resultado */
.res-cargo{margin-bottom:20px}
.res-titulo{font-size:15px;font-weight:700;color:#e2e8f0;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,.08)}
.res-row{display:flex;align-items:center;gap:12px;margin-bottom:8px}
.res-rank{font-size:13px;color:#5a7a96;min-width:22px;text-align:center}
.res-nome{font-size:14px;font-weight:600;flex:1}
.res-votos{font-size:18px;font-weight:900;min-width:36px;text-align:right}
.res-pct{font-size:12px;color:#5a7a96;min-width:40px;text-align:right}
.res-bar{flex:2;background:rgba(255,255,255,.08);border-radius:100px;height:8px;overflow:hidden}
.res-bar-fill{height:100%;border-radius:100px;transition:width 1s ease}
.eleito{color:#4ade80}.neleito{color:#e2e8f0}
.badge-eleito{background:rgba(74,222,128,.15);color:#4ade80;border:1px solid rgba(74,222,128,.3);font-size:11px;font-weight:700;padding:2px 8px;border-radius:100px}
.branco-row{font-size:12px;color:#5a7a96;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.06)}
.upd{position:fixed;bottom:14px;right:18px;font-size:11px;color:#2d4a61}
#logo{max-height:48px;object-fit:contain}
</style></head><body>
<div class="topbar">
  <div style="display:flex;align-items:center;gap:14px">
    <div id="logo-wrap"></div>
    <div><h1 id="titulo-inst">🗳️ Eleição de Oficiais</h1><p class="sub">Painel em tempo real</p></div>
  </div>
  <div id="badge" class="badge b-agd"><div class="dot dg"></div>Carregando...</div>
</div>
<div class="stats">
  <div class="stat"><div class="slbl">Eleitores presentes</div><div class="sval cb" id="s1">—</div></div>
  <div class="stat"><div class="slbl">Já votaram</div><div class="sval cg" id="s2">—</div></div>
  <div class="stat"><div class="slbl">Aguardando</div><div class="sval ca" id="s3">—</div></div>
</div>
<div class="prog-wrap"><div class="prog-fill" id="prog" style="width:0%"></div></div>
<p class="prog-lbl" id="prog-lbl">Carregando...</p>
<div id="main-content"></div>
<div class="upd" id="upd">Atualizando...</div>

<script>
const esc=s=>(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
let firstRun=true;
async function tick(){
  try{
    const d=await(await fetch('/api/datashow')).json();

    // Config visual
    if(firstRun){
      firstRun=false;
      if(d.config?.logoUrl) document.getElementById('logo-wrap').innerHTML='<img id="logo" src="'+esc(d.config.logoUrl)+'">';
      if(d.config?.nomeInstituicao) document.getElementById('titulo-inst').textContent='🗳️ '+d.config.nomeInstituicao;
    }

    // Badge
    const badge=document.getElementById('badge');
    if(d.elStatus==='ativa'){badge.className='badge b-ativa';badge.innerHTML='<div class="dot dl"></div>Eleição em andamento';}
    else if(d.elStatus==='encerrada'){badge.className='badge b-enc';badge.innerHTML='<div class="dot dy"></div>Eleição encerrada';}
    else{badge.className='badge b-agd';badge.innerHTML='<div class="dot dg"></div>Aguardando início';}

    document.getElementById('s1').textContent=d.presentes;
    document.getElementById('s2').textContent=d.jaVotou;
    document.getElementById('s3').textContent=d.naoVotouCount||0;

    const pct=d.presentes>0?Math.round(d.jaVotou/d.presentes*100):0;
    document.getElementById('prog').style.width=pct+'%';
    document.getElementById('prog-lbl').textContent=d.presentes>0?pct+'% — '+d.jaVotou+' de '+d.presentes+' eleitores votaram':'Nenhum eleitor presente';

    const mc=document.getElementById('main-content');

    if(d.elStatus==='encerrada' && d.apuracao){
      // Resultado: ordenado por votos decrescente por cargo
      let html='';
      for(const a of d.apuracao){
        html+='<div class="res-cargo"><div class="res-titulo">'+esc(a.cargo)+' — '+a.vagas+' vaga'+(a.vagas>1?'s':'')+'</div>';
        const maxV=a.rank.length>0?a.rank[0].votos:1;
        a.rank.forEach((r,i)=>{
          const barPct=maxV>0?Math.round(r.votos/maxV*100):0;
          const pctPres=d.presentes>0?Math.round(r.votos/d.presentes*100):0;
          html+='<div class="res-row">'
            +'<span class="res-rank">#'+(i+1)+'</span>'
            +'<span class="res-nome '+(r.eleito?'eleito':'neleito')+'">'+esc(r.nome)+(r.eleito?' <span class="badge-eleito">Eleito ✓</span>':'')+'</span>'
            +'<div class="res-bar"><div class="res-bar-fill" style="width:'+barPct+'%;background:'+(r.eleito?'#4ade80':'#60a5fa')+'"></div></div>'
            +'<span class="res-pct">'+pctPres+'%</span>'
            +'<span class="res-votos '+(r.eleito?'eleito':'neleito')+'">'+r.votos+'</span>'
            +'</div>';
        });
        if(a.branco>0){
          const pb=d.presentes>0?Math.round(a.branco/d.presentes*100):0;
          html+='<div class="branco-row">Votos em branco / nulos: '+a.branco+' ('+pb+'%)</div>';
        }
        html+='<div style="font-size:11px;color:#3d5166;margin-top:6px">Maioria necessária: '+a.maioria+' votos (50% dos '+d.presentes+' presentes)</div>';
        html+='</div>';
      }
      mc.innerHTML=html;
    } else if(d.elStatus==='ativa'){
      let html='';
      var cnt = d.naoVotouCount || 0;
      if(cnt===0 && d.elStatus==='ativa'){
        html='<div style="text-align:center;padding:32px;font-size:22px;font-weight:700;color:#4ade80">🎉 Todos os presentes já votaram!</div>';
      } else if(cnt>0) {
        html='<div style="text-align:center;padding:24px">'
          +'<p style="font-size:64px;font-weight:900;color:#fbbf24;line-height:1">'+cnt+'</p>'
          +'<p style="font-size:18px;color:#8899aa;margin-top:10px">eleitor'+(cnt!==1?'es':'')+' ainda aguardando para votar</p>'
          +'</div>';
      } else {
        html='<div style="text-align:center;padding:32px;color:#3d5166">Nenhum eleitor presente ainda.</div>';
      }
      mc.innerHTML=html;
    } else {
      mc.innerHTML='<div style="text-align:center;padding:32px;color:#3d5166">Aguardando início da eleição...</div>';
    }

    document.getElementById('upd').textContent='Última atualização: '+new Date().toLocaleTimeString('pt-BR');
  }catch(e){document.getElementById('upd').textContent='Aguardando conexão...';}
}
tick();setInterval(tick,2000);
</script></body></html>`;
}

// ──────────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  let ip = 'localhost';
  for (const iface of Object.values(nets))
    for (const n of iface)
      if (n.family === 'IPv4' && !n.internal) { ip = n.address; break; }
  const U = 'http://' + ip + ':' + PORT;
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  🗳️  ' + ''.padEnd(40) + '║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  Admin:    ' + ('http://localhost:' + PORT).padEnd(34) + '║');
  console.log('║  Rede:     ' + U.padEnd(34) + '║');
  console.log('║  Votação:  ' + (U+'/votar').padEnd(34) + '║');
  console.log('║  Check-in: ' + (U+'/checkin').padEnd(34) + '║');
  console.log('║  Datashow: ' + (U+'/datashow').padEnd(34) + '║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  admin: usuário "admin" / senha "admin"   ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
