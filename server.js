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
    { id:'c1', userId:'u1', nome:'Ana Oliveira', idade:42, fotoUrl:'', cargoId:'g2' },
    { id:'c2', userId:'u2', nome:'Bruno Santos', idade:38, fotoUrl:'', cargoId:'g1' },
  ],
  cargos:    [ { id:'g1', nome:'Diácono', vagas:2 }, { id:'g2', nome:'Presbítero', vagas:1 } ],
  presentes: [],   // [{id, dataHora}]
  // Eleição POR CARGO:
  // - elStatus: 'aguardando' | 'ativa' | 'encerrada' (status do cargo ativo no momento)
  // - cargoAtivo: id do cargo em votação no momento (ou null)
  // - resultados: { cargoId: { candId: votos, branco: n } }
  // - cargosVotados: { cargoId: [userId, ...] }  (quem já votou em cada cargo)
  // - cargosEncerrados: [cargoId, ...]  (cargos cuja votação foi finalizada)
  jaVotou:   [], resultados: {}, elStatus: 'aguardando',
  cargoAtivo: null, cargosVotados: {}, cargosEncerrados: [],
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
      s.candidatos = (s.candidatos||[]).map(c=>({userId:'',fotoUrl:'',cargoId:null,...c,desc:undefined}));
      // Migração automática: presentes legados (array de strings → objetos)
      s.presentes  = migrarPresentes(s.presentes||[]);
      // Migração para modelo por cargo
      if(s.cargoAtivo===undefined)       s.cargoAtivo=null;
      if(!s.cargosVotados)               s.cargosVotados={};
      if(!Array.isArray(s.cargosEncerrados)) s.cargosEncerrados=[];
      if(!s.resultados)                  s.resultados={};
      // jaVotou legado não é mais usado no modelo por cargo
      delete s.jaVotou;
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

// Compara CPFs apenas pelos dígitos (ignora máscara/formatação)
function cpfDigits(cpf){ return (cpf||'').replace(/\D/g,''); }
function findUserByCPF(cpf){
  const d=cpfDigits(cpf);
  if(d.length!==11)return null;
  return ST.users.find(u=>cpfDigits(u.cpf)===d)||null;
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
    // CPF é opcional na importação — membro pode não ter CPF ainda
    if(!nome){skipped++;continue;}
    let cpfFmt='';
    if(cpfRaw){
      const cpfLimpo=cpfRaw.replace(/\D/g,'');
      if(!validCPF(cpfLimpo)){erros.push('CPF inválido: '+cpfRaw);skipped++;continue;}
      cpfFmt=fmtCPF(cpfLimpo);
      // Pula se CPF já cadastrado
      if(ST.users.find(u=>u.cpf&&cpfDigits(u.cpf)===cpfDigits(cpfFmt))){skipped++;continue;}
    }
    // Pula se nome exatamente igual já existe sem CPF (evita duplicata)
    if(!cpfFmt&&ST.users.find(u=>u.nome.toLowerCase()===nome.toLowerCase()&&!u.cpf)){skipped++;continue;}
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
function sendHTML(res,html){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Cache-Control':'no-store, no-cache, must-revalidate, max-age=0','Pragma':'no-cache','Expires':'0'});res.end(html);}
function sendXLSX(res,buf,name){res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="${name}"`,'Content-Length':buf.length});res.end(buf);}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function getToken(req){const p=url.parse(req.url,true);return req.headers['x-admin-token']||p.query.t||'';}
function isAdmin(req) {return sessionOk(getToken(req));}
function deny(res)    {sendJSON(res,{error:'Não autorizado. Faça login como administrador.'},401);}
function getIP(req)   {return req.headers['x-forwarded-for']?.split(',')[0]||req.socket.remoteAddress||'unknown';}
function safeExt(fn)  {const ok=['.jpg','.jpeg','.png','.gif','.webp'];const e=path.extname(fn||'').toLowerCase();return ok.includes(e)?e:'.jpg';}

// ─── Apuração ─────────────────────────────────────────────────────────────────
// Apura um cargo específico. total = nº de pessoas que votaram NESTE cargo.
function apurarCargo(cargo){
  const votantes=(ST.cargosVotados[cargo.id]||[]).length;
  const total=votantes;
  const res=ST.resultados[cargo.id]||{},branco=res.branco||0;
  const rank=Object.entries(res)
    .filter(([k])=>k!=='branco')
    .map(([cid,v])=>{const c=ST.candidatos.find(x=>x.id===cid);return c?{cid,c,v}:null;})
    .filter(Boolean)
    .sort((a,b)=>b.v-a.v);
  const maioria=Math.ceil(total/2);
  const eleitos=rank.filter((r,i)=>i<cargo.vagas&&r.v>=maioria&&r.v>0);
  return{cargo,rank,eleitos,branco,total,maioria,votantes};
}

// Apura todos os cargos (usado em relatórios)
function apurar(){
  return ST.cargos.map(cargo=>apurarCargo(cargo));
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVIDOR
// ══════════════════════════════════════════════════════════════════════════════
const server = http.createServer(async(req,res)=>{
  const p=url.parse(req.url,true),m=req.method;
  let pn;
  try { pn=decodeURIComponent(p.pathname); }
  catch(e){ pn=p.pathname; }  // URL malformada — usa o caminho cru sem decodificar
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
      elStatus:ST.elStatus, cargoAtivo:ST.cargoAtivo,
      cargosEncerrados:ST.cargosEncerrados, cargosVotados:ST.cargosVotados,
      resultados:ST.resultados,
      config:ST.config, version:VERSION,
    });
  }
  if(m==='GET'&&pn==='/api/config'){return sendJSON(res,ST.config);}

  if(m==='GET'&&pn==='/api/datashow'){
    const totalPresentes=ST.presentes.length;
    // Cargo ativo no momento
    const cargoAtivoObj=ST.cargoAtivo?ST.cargos.find(g=>g.id===ST.cargoAtivo):null;
    const votadosAtivo=ST.cargoAtivo?(ST.cargosVotados[ST.cargoAtivo]||[]).length:0;
    // Apuração dos cargos já encerrados
    const encerrados=ST.cargosEncerrados.map(gid=>{
      const cargo=ST.cargos.find(g=>g.id===gid);
      if(!cargo)return null;
      const a=apurarCargo(cargo);
      return{cargo:a.cargo.nome,vagas:a.cargo.vagas,branco:a.branco,maioria:a.maioria,votantes:a.votantes,
        rank:a.rank.map(r=>({nome:r.c.nome,votos:r.v,eleito:a.eleitos.some(e=>e.cid===r.cid)}))};
    }).filter(Boolean);
    return sendJSON(res,{
      elStatus:ST.elStatus,
      presentes:totalPresentes,
      cargoAtivo:cargoAtivoObj?{nome:cargoAtivoObj.nome,vagas:cargoAtivoObj.vagas,votaram:votadosAtivo,naoVotaram:totalPresentes-votadosAtivo}:null,
      encerrados,
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
    const u=findUserByCPF(cpf);
    if(!u)return sendJSON(res,{error:'CPF não encontrado no cadastro.'},401);
    if(!presIncludes(ST.presentes,u.id))return sendJSON(res,{error:'Você não está marcado como presente.'},403);
    // No modelo por cargo, verifica se já votou no cargo ATIVO
    const jaVotouCargo=ST.cargoAtivo&&(ST.cargosVotados[ST.cargoAtivo]||[]).includes(u.id);
    return sendJSON(res,{ok:true,user:{id:u.id,nome:u.nome,cpf:u.cpf},elStatus:ST.elStatus,cargoAtivo:ST.cargoAtivo,jaVotouCargo});
  }

  if(m==='POST'&&pn==='/api/votar'){
    const{userId,votos}=await jsonBody(req);
    if(!userId||!votos)return sendJSON(res,{error:'Dados inválidos.'},400);
    if(ST.elStatus!=='ativa'||!ST.cargoAtivo)return sendJSON(res,{error:'Nenhuma votação ativa no momento.'},403);
    if(!presIncludes(ST.presentes,userId))return sendJSON(res,{error:'Usuário não está presente.'},403);
    // Vota APENAS no cargo ativo
    const g=ST.cargos.find(x=>x.id===ST.cargoAtivo);
    if(!g)return sendJSON(res,{error:'Cargo ativo inválido.'},400);
    if(!ST.cargosVotados[g.id])ST.cargosVotados[g.id]=[];
    if(ST.cargosVotados[g.id].includes(userId))return sendJSON(res,{error:'Você já votou neste cargo.'},409);
    if(!ST.resultados[g.id])ST.resultados[g.id]={branco:0};
    // Aceita votos[g.id] OU votos diretamente como array
    const sel=Array.isArray(votos[g.id])?votos[g.id]:(Array.isArray(votos)?votos:[]);
    // Valida que candidatos pertencem a este cargo
    const sv=sel.filter(cid=>ST.candidatos.find(c=>c.id===cid&&c.cargoId===g.id)).slice(0,g.vagas);
    ST.resultados[g.id].branco+=(g.vagas-sv.length);
    sv.forEach(cid=>{ST.resultados[g.id][cid]=(ST.resultados[g.id][cid]||0)+1;});
    ST.cargosVotados[g.id].push(userId);
    saveState(ST);
    return sendJSON(res,{ok:true});
  }

  if(m==='GET'&&pn==='/api/resultados'){
    // Retorna resultados de todos os cargos já encerrados
    if(!ST.cargosEncerrados.length)return sendJSON(res,{error:'Nenhum cargo foi encerrado ainda.'},403);
    return sendJSON(res,{resultados:ST.resultados,cargos:ST.cargos,candidatos:ST.candidatos,cargosEncerrados:ST.cargosEncerrados,cargosVotados:ST.cargosVotados,totalPresentes:ST.presentes.length});
  }

  if(m==='POST'&&pn==='/api/checkin/buscar'){
    const{cpf}=await jsonBody(req);
    if(!cpf)return sendJSON(res,{error:'CPF obrigatório.'},400);
    const u=findUserByCPF(cpf);
    // CPF não encontrado — retorna flag para mostrar busca por nome
    if(!u)return sendJSON(res,{naoEncontrado:true,cpf});
    const entry=presFindEntry(ST.presentes,u.id);
    return sendJSON(res,{ok:true,user:{id:u.id,nome:u.nome,cpf:u.cpf},jaPresente:!!entry,dataHora:entry&&entry.dataHora||null});
  }

  // Busca membros por nome (para check-in quando CPF não é encontrado)
  if(m==='GET'&&pn==='/api/checkin/buscar-nome'){
    const q=(url.parse(req.url,true).query.q||'').trim().toLowerCase();
    if(!q||q.length<2)return sendJSON(res,{users:[]});
    // Retorna todos os membros que batem o nome (com ou sem CPF)
    // O frontend distinguirá os dois casos
    const found=ST.users.filter(u=>u.nome.toLowerCase().includes(q)).slice(0,10);
    return sendJSON(res,{users:found.map(u=>({id:u.id,nome:u.nome,temCPF:!!(u.cpf)}))});
  }

  // Confirma presença por userId + verifica CPF (para membro encontrado pelo nome que já tem CPF)
  if(m==='POST'&&pn==='/api/checkin/confirmar-por-id'){
    const{userId,cpf}=await jsonBody(req);
    if(!userId||!cpf)return sendJSON(res,{error:'Dados obrigatórios.'},400);
    const u=ST.users.find(x=>x.id===userId);
    if(!u)return sendJSON(res,{error:'Membro não encontrado.'},404);
    const cpfLimpo=cpf.replace(/\D/g,'');
    if(!validCPF(cpfLimpo))return sendJSON(res,{error:'CPF inválido.'},400);
    const cpfFmt=fmtCPF(cpfLimpo);
    // Verifica que o CPF confere com o cadastrado
    if(u.cpf&&u.cpf!==cpfFmt)return sendJSON(res,{error:'CPF incorreto. Não confere com o cadastro deste membro.'},403);
    if(!presIncludes(ST.presentes,userId)){
      presAdd(ST.presentes,userId);
    }
    saveState(ST);
    return sendJSON(res,{ok:true,user:{id:u.id,nome:u.nome,cpf:u.cpf}});
  }

  // Registra CPF em membro que ainda não tinha, e confirma presença
  if(m==='POST'&&pn==='/api/checkin/registrar-cpf'){
    const{userId,cpf}=await jsonBody(req);
    if(!userId||!cpf)return sendJSON(res,{error:'Dados obrigatórios.'},400);
    const u=ST.users.find(x=>x.id===userId);
    if(!u)return sendJSON(res,{error:'Membro não encontrado.'},404);
    const cpfLimpo=cpf.replace(/\D/g,'');
    if(!validCPF(cpfLimpo))return sendJSON(res,{error:'CPF inválido. Verifique os dígitos.'},400);
    const cpfFmt=fmtCPF(cpfLimpo);
    // Garante que o CPF não está em uso por outro membro
    const outro=ST.users.find(x=>x.cpf&&cpfDigits(x.cpf)===cpfDigits(cpfFmt)&&x.id!==userId);
    if(outro)return sendJSON(res,{error:'Este CPF já está cadastrado para outro membro.'},409);
    // Salva o CPF no cadastro
    u.cpf=cpfFmt;
    // Confirma presença
    if(!presIncludes(ST.presentes,userId)){
      presAdd(ST.presentes,userId);
    }
    saveState(ST);
    return sendJSON(res,{ok:true,user:{id:u.id,nome:u.nome,cpf:u.cpf}});
  }

  if(m==='POST'&&pn==='/api/checkin/confirmar'){
    const{cpf}=await jsonBody(req);
    const u=findUserByCPF(cpf);
    if(!u)return sendJSON(res,{error:'CPF não encontrado.'},404);
    if(presIncludes(ST.presentes,u.id))return sendJSON(res,{ok:true,msg:'Presença já confirmada.',user:{id:u.id,nome:u.nome}});
    presAdd(ST.presentes,u.id);saveState(ST);
    return sendJSON(res,{ok:true,msg:'Presença confirmada!',user:{id:u.id,nome:u.nome}});
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
        return u?{nome:u.nome,cpf:u.cpf,dataHora:dh}:null;
      })
      .filter(Boolean)
      .sort((a,b)=>a.nome.localeCompare(b.nome));
    const hdr=[
      {v:'#',bold:true,bg:'4472C4'},{v:'Nome Completo',bold:true,bg:'4472C4'},
      {v:'CPF',bold:true,bg:'4472C4'},{v:'Data/Hora Check-in',bold:true,bg:'4472C4'},
    ];
    const buf=buildXLSX([{name:'Presença',rows:[hdr,...rows.map((r,i)=>[i+1,r.nome,r.cpf,fmtDataHora(r.dataHora)])]}]);
    return sendXLSX(res,buf,'lista-presenca.xlsx');
  }

  // Membros
  if(m==='GET'&&pn==='/api/usuarios/exportar'){
    // Exporta membros como XLSX
    const hdr=[{v:'Nome Completo',bold:true,bg:'4472C4'},{v:'CPF',bold:true,bg:'4472C4'}];
    const rows=ST.users.slice().sort((a,b)=>a.nome.localeCompare(b.nome)).map(u=>[u.nome,u.cpf]);
    const buf=buildXLSX([{name:'Membros',rows:[hdr,...rows]}]);
    return sendXLSX(res,buf,'membros.xlsx');
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
    if(!nome)return sendJSON(res,{error:'Nome obrigatório.'},400);
    let cpfFmt='';
    if(cpf){
      const cpfLimpo=cpf.replace(/\D/g,'');
      if(!validCPF(cpfLimpo))return sendJSON(res,{error:'CPF inválido.'},400);
      cpfFmt=fmtCPF(cpfLimpo);
      if(ST.users.find(u=>u.cpf&&cpfDigits(u.cpf)===cpfDigits(cpfFmt)))return sendJSON(res,{error:'CPF já cadastrado.'},409);
    }
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
      if(ST.users.find(x=>cpfDigits(x.cpf)===cpfDigits(cf)&&x.id!==id))return sendJSON(res,{error:'CPF já em uso.'},409);
      u.cpf=cf;
    }
    saveState(ST);return sendJSON(res,{ok:true,user:u});
  }
  if(m==='DELETE'&&pn.startsWith('/api/usuarios/')){
    const id=pn.split('/')[3];
    ST.users=ST.users.filter(u=>u.id!==id);
    presRemove(ST.presentes,id);
    Object.keys(ST.cargosVotados).forEach(gid=>{ST.cargosVotados[gid]=ST.cargosVotados[gid].filter(x=>x!==id);});
    ST.candidatos=ST.candidatos.filter(c=>c.userId!==id);
    saveState(ST);return sendJSON(res,{ok:true});
  }

  // Candidatos — sem campo desc na criação
  if(m==='POST'&&pn==='/api/candidatos'){
    const{userId,idade,cargoId}=await jsonBody(req);
    if(!userId)return sendJSON(res,{error:'Selecione um membro.'},400);
    if(!cargoId)return sendJSON(res,{error:'Selecione o cargo que o candidato irá concorrer.'},400);
    const u=ST.users.find(x=>x.id===userId);
    if(!u)return sendJSON(res,{error:'Membro não encontrado.'},404);
    const cargo=ST.cargos.find(g=>g.id===cargoId);
    if(!cargo)return sendJSON(res,{error:'Cargo não encontrado.'},404);
    // Um mesmo membro pode ser candidato em cargos diferentes? Não — um membro = um cargo.
    if(ST.candidatos.find(c=>c.userId===userId))return sendJSON(res,{error:'Este membro já é candidato.'},409);
    const c={id:genId(),userId,nome:u.nome,idade:Number(idade)||0,fotoUrl:'',cargoId};
    ST.candidatos.push(c);saveState(ST);return sendJSON(res,{ok:true,candidato:c});
  }
  if(m==='PATCH'&&pn.match(/^\/api\/candidatos\/[^/]+$/)&&!pn.includes('/foto')){
    const id=pn.split('/')[3],c=ST.candidatos.find(x=>x.id===id);
    if(!c)return sendJSON(res,{error:'Candidato não encontrado.'},404);
    const b=await jsonBody(req);
    if(b.idade!==undefined)c.idade=Number(b.idade);
    if(b.cargoId!==undefined){
      const cargo=ST.cargos.find(g=>g.id===b.cargoId);
      if(!cargo)return sendJSON(res,{error:'Cargo não encontrado.'},404);
      c.cargoId=b.cargoId;
    }
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
  if(m==='DELETE'&&pn.startsWith('/api/cargos/')){
    const gid=pn.split('/')[3];
    ST.cargos=ST.cargos.filter(g=>g.id!==gid);
    // Remove candidatos do cargo, resultados e votos
    ST.candidatos=ST.candidatos.filter(c=>c.cargoId!==gid);
    delete ST.resultados[gid];
    delete ST.cargosVotados[gid];
    ST.cargosEncerrados=ST.cargosEncerrados.filter(x=>x!==gid);
    if(ST.cargoAtivo===gid){ST.cargoAtivo=null;ST.elStatus='aguardando';}
    saveState(ST);return sendJSON(res,{ok:true});
  }

  // Eleição
  // Inicia a votação de UM cargo específico
  if(m==='POST'&&pn==='/api/eleicao/iniciar'){
    const{cargoId}=await jsonBody(req);
    if(!ST.presentes.length)return sendJSON(res,{error:'Marque presença de pelo menos 1 membro.'},400);
    if(!cargoId)return sendJSON(res,{error:'Selecione o cargo para iniciar a votação.'},400);
    const cargo=ST.cargos.find(g=>g.id===cargoId);
    if(!cargo)return sendJSON(res,{error:'Cargo não encontrado.'},404);
    if(ST.elStatus==='ativa'&&ST.cargoAtivo)return sendJSON(res,{error:'Já existe uma votação em andamento. Encerre-a antes de iniciar outra.'},409);
    if(ST.cargosEncerrados.includes(cargoId))return sendJSON(res,{error:'Este cargo já foi encerrado. Use "Refazer votação" se necessário.'},409);
    const candsCargo=ST.candidatos.filter(c=>c.cargoId===cargoId);
    if(!candsCargo.length)return sendJSON(res,{error:'Não há candidatos cadastrados para este cargo.'},400);
    // Inicializa votação do cargo
    ST.cargoAtivo=cargoId;
    ST.elStatus='ativa';
    if(!ST.cargosVotados[cargoId])ST.cargosVotados[cargoId]=[];
    if(!ST.resultados[cargoId])ST.resultados[cargoId]={branco:0};
    saveState(ST);return sendJSON(res,{ok:true,cargo:cargo.nome});
  }
  // Encerra a votação do cargo ativo
  if(m==='POST'&&pn==='/api/eleicao/encerrar'){
    if(ST.elStatus!=='ativa'||!ST.cargoAtivo)return sendJSON(res,{error:'Nenhuma votação ativa para encerrar.'},400);
    const gid=ST.cargoAtivo;
    if(!ST.cargosEncerrados.includes(gid))ST.cargosEncerrados.push(gid);
    ST.cargoAtivo=null;
    ST.elStatus='aguardando';  // volta a aguardando para permitir iniciar outro cargo
    saveState(ST);return sendJSON(res,{ok:true});
  }
  // Refaz a votação de um cargo já encerrado (apaga seus votos)
  if(m==='POST'&&pn==='/api/eleicao/reiniciar-cargo'){
    const{cargoId}=await jsonBody(req);
    if(!cargoId)return sendJSON(res,{error:'Informe o cargo.'},400);
    const cargo=ST.cargos.find(g=>g.id===cargoId);
    if(!cargo)return sendJSON(res,{error:'Cargo não encontrado.'},404);
    // Limpa votos e resultados do cargo
    ST.resultados[cargoId]={branco:0};
    ST.cargosVotados[cargoId]=[];
    ST.cargosEncerrados=ST.cargosEncerrados.filter(x=>x!==cargoId);
    if(ST.cargoAtivo===cargoId){ST.cargoAtivo=null;ST.elStatus='aguardando';}
    saveState(ST);return sendJSON(res,{ok:true});
  }
  // Reinicia TODA a eleição (apaga todos os votos de todos os cargos)
  if(m==='POST'&&pn==='/api/eleicao/reiniciar'){
    ST.elStatus='aguardando';
    ST.cargoAtivo=null;
    ST.resultados={};
    ST.cargosVotados={};
    ST.cargosEncerrados=[];
    saveState(ST);return sendJSON(res,{ok:true});
  }

  // Resultado XLSX
  if(m==='GET'&&pn==='/api/resultados/exportar-xlsx'){
    if(!ST.cargosEncerrados.length)return sendJSON(res,{error:'Nenhum cargo encerrado.'},403);
    const sheets=[];
    // Aba resumo geral
    const resumoRows=[
      [{v:APP_NAME+' v'+VERSION,bold:true,bg:'4472C4'},'',''],['','',''],
      [{v:'Total de membros',bold:true},ST.users.length,''],
      [{v:'Total de presentes',bold:true},ST.presentes.length,''],['','',''],
      [{v:'CARGO',bold:true,bg:'4472C4'},{v:'RESULTADO',bold:true,bg:'4472C4'},{v:'VOTANTES',bold:true,bg:'4472C4'}],
    ];
    for(const gid of ST.cargosEncerrados){
      const cargo=ST.cargos.find(g=>g.id===gid);
      if(!cargo)continue;
      const a=apurarCargo(cargo);
      resumoRows.push([{v:cargo.nome,bold:true},a.eleitos.length+' eleito(s) de '+cargo.vagas+' vaga(s)',a.votantes+' votaram']);
    }
    sheets.push({name:'Resumo',rows:resumoRows});
    // Uma aba por cargo encerrado
    for(const gid of ST.cargosEncerrados){
      const cargo=ST.cargos.find(g=>g.id===gid);
      if(!cargo)continue;
      const a=apurarCargo(cargo);
      const hdr=[[{v:'#',bold:true,bg:'4472C4'},{v:'Candidato',bold:true,bg:'4472C4'},{v:'Votos',bold:true,bg:'4472C4'},{v:'% dos votantes',bold:true,bg:'4472C4'},{v:'Situação',bold:true,bg:'4472C4'}]];
      const rows=a.rank.map((r,i)=>{
        const pct=a.total>0?(r.v/a.total*100).toFixed(1)+'%':'0%',el=a.eleitos.some(e=>e.cid===r.cid);
        return[i+1,el?{v:r.c.nome,bold:true,bg:'70AD47'}:r.c.nome,el?{v:r.v,bold:true,bg:'70AD47'}:r.v,el?{v:pct,bold:true,bg:'70AD47'}:pct,el?{v:'ELEITO ✓',bold:true,bg:'70AD47'}:(r.v>0?'Não eleito':'Sem votos')];
      });
      if(a.branco>0)rows.push(['—','Votos em branco / nulos',a.branco,'—','—']);
      rows.push(['','','','','']);
      rows.push([{v:'Maioria necessária',bold:true},a.maioria+' votos','','','']);
      rows.push([{v:'Total de votantes',bold:true},a.votantes,'','','']);
      sheets.push({name:cargo.nome.slice(0,31),rows:[...hdr,...rows]});
    }
    // Lista de presença
    const pr=ST.presentes.map(p=>{
      const id=typeof p==='string'?p:p.id,dh=typeof p==='string'?null:p.dataHora;
      const u=ST.users.find(x=>x.id===id);
      return u?{nome:u.nome,cpf:u.cpf,dataHora:dh}:null;
    }).filter(Boolean).sort((a,b)=>a.nome.localeCompare(b.nome));
    sheets.push({name:'Lista de Presença',rows:[
      [{v:'#',bold:true,bg:'4472C4'},{v:'Nome',bold:true,bg:'4472C4'},{v:'CPF',bold:true,bg:'4472C4'},{v:'Data/Hora Check-in',bold:true,bg:'4472C4'}],
      ...pr.map((u,i)=>[i+1,u.nome,u.cpf,fmtDataHora(u.dataHora)])
    ]});
    return sendXLSX(res,buildXLSX(sheets),'resultado-eleicao.xlsx');
  }

  // Exporta resultado de UM cargo específico
  if(m==='GET'&&pn.match(/^\/api\/resultados\/cargo\/[^/]+\/exportar-xlsx$/)){
    const gid=pn.split('/')[4];
    const cargo=ST.cargos.find(g=>g.id===gid);
    if(!cargo)return sendJSON(res,{error:'Cargo não encontrado.'},404);
    if(!ST.cargosEncerrados.includes(gid))return sendJSON(res,{error:'Este cargo ainda não foi encerrado.'},403);
    const a=apurarCargo(cargo);
    const hdr=[[{v:'#',bold:true,bg:'4472C4'},{v:'Candidato',bold:true,bg:'4472C4'},{v:'Votos',bold:true,bg:'4472C4'},{v:'% dos votantes',bold:true,bg:'4472C4'},{v:'Situação',bold:true,bg:'4472C4'}]];
    const rows=a.rank.map((r,i)=>{
      const pct=a.total>0?(r.v/a.total*100).toFixed(1)+'%':'0%',el=a.eleitos.some(e=>e.cid===r.cid);
      return[i+1,el?{v:r.c.nome,bold:true,bg:'70AD47'}:r.c.nome,el?{v:r.v,bold:true,bg:'70AD47'}:r.v,el?{v:pct,bold:true,bg:'70AD47'}:pct,el?{v:'ELEITO ✓',bold:true,bg:'70AD47'}:(r.v>0?'Não eleito':'Sem votos')];
    });
    if(a.branco>0)rows.push(['—','Votos em branco / nulos',a.branco,'—','—']);
    rows.push(['','','','','']);
    rows.push([{v:'Maioria necessária',bold:true},a.maioria+' votos','','','']);
    rows.push([{v:'Total de votantes',bold:true},a.votantes,'','','']);
    const sheets=[{name:cargo.nome.slice(0,31),rows:[...hdr,...rows]}];
    return sendXLSX(res,buildXLSX(sheets),'resultado-'+cargo.nome.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.xlsx');
  }

  return sendJSON(res,{error:'Rota não encontrada.'},404);
});

function checkinPage() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Check-in</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg,#f0ede6);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;padding:28px 24px;width:100%;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:21px;font-weight:700;margin-bottom:6px}
.sub{font-size:13px;color:#888;margin-bottom:20px;line-height:1.5}
.flabel{font-size:12px;color:#666;display:block;margin-bottom:5px;font-weight:600}
input[type=text]{width:100%;padding:12px 14px;border-radius:10px;border:1.5px solid #ddd;font-size:16px;outline:none;transition:border-color .15s;background:#fafaf8;font-family:inherit;-webkit-text-security:none !important;text-security:none !important;letter-spacing:.5px}
input[type=text]:focus{border-color:var(--p,#185FA5)}
.btn{width:100%;margin-top:12px;padding:13px;border-radius:10px;border:none;font-size:15px;font-weight:700;cursor:pointer;background:var(--p,#185FA5);color:#fff;transition:opacity .15s}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-sec{background:transparent;color:var(--p,#185FA5);border:1.5px solid var(--p,#185FA5);margin-top:10px}
.btn-green{background:var(--s,#3B6D11)}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:20px;z-index:100}
.modal{background:#fff;border-radius:16px;padding:24px;width:100%;max-width:380px}
.drow{display:flex;gap:8px;padding:8px 0;border-bottom:1px solid #f0ede6}
.dl{font-size:11px;color:#aaa;min-width:52px;font-weight:600;text-transform:uppercase;padding-top:2px}
.dv{font-size:15px;font-weight:700}
.btn-row{display:flex;gap:10px;margin-top:18px}
.btn-row button{flex:1;padding:11px;border-radius:9px;font-size:14px;font-weight:700;cursor:pointer;border:none}
.bc{background:#f0ede6;color:#666}
.bg{background:var(--s,#3B6D11);color:#fff}
.msg-err{background:#fcebeb;color:#a32d2d;border-radius:8px;padding:10px;font-size:13px;margin-top:10px}
.msg-ok{background:#eaf3de;color:#3B6D11;border-radius:8px;padding:10px;font-size:13px;margin-top:10px;font-weight:600}
.info-box{background:#e8f0fe;color:#185FA5;border-radius:8px;padding:10px 14px;font-size:12px;line-height:1.6;margin-bottom:14px}
.divider{border:none;border-top:1px solid #eee;margin:18px 0}
/* busca por nome */
.member-card{display:flex;align-items:center;gap:12px;padding:11px 13px;border-radius:10px;border:1.5px solid #ddd;background:#fff;cursor:pointer;margin-bottom:7px;transition:all .15s}
.member-card:hover{border-color:var(--p,#185FA5);background:#f0f6ff}
.member-card.sel{border-color:var(--p,#185FA5);background:#e6f1fb}
.member-av{width:38px;height:38px;border-radius:50%;background:var(--p,#185FA5);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0}
.cpf-badge{display:inline-block;font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;margin-top:3px}
.sem-cpf{background:#faeeda;color:#854F0B}
.tem-cpf{background:#eee;color:#666}
/* tela sucesso */
.redirect-bar{height:4px;background:#eee;border-radius:2px;margin-top:16px;overflow:hidden}
.redirect-fill{height:100%;background:var(--s,#3B6D11);border-radius:2px;transition:width 3s linear}
#logo-img{max-height:52px}
</style>
</head>
<body>

<!-- ── TELA PRINCIPAL ───────────────────────────────── -->
<div id="tela-cpf">
  <div class="card">
    <div id="logo-wrap" style="text-align:center;margin-bottom:10px"></div>
    <div style="font-size:42px;text-align:center;margin-bottom:10px">🗳️</div>
    <h1 id="nome-inst">Check-in</h1>
    <p class="sub">Digite seu CPF para confirmar sua presença.</p>

    <label class="flabel">Seu CPF</label>
    <input type="text" id="cpf-in" inputmode="numeric" placeholder="000.000.000-00" maxlength="14" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore data-form-type="other" name="documento-checkin">
    <div id="msg-cpf" style="display:none"></div>
    <button class="btn" id="btn-cpf" onclick="buscarCPF()">Confirmar presença</button>

    <hr class="divider" id="div-nome" style="display:none">

    <!-- Painel de busca por nome — aparece quando CPF não encontrado -->
    <div id="painel-nome" style="display:none">
      <p style="font-size:13px;font-weight:700;margin-bottom:6px">🔍 Procurar meu nome na lista</p>
      <div class="info-box">
        Seu CPF não foi encontrado. Se você está na lista de membros,
        encontre seu nome abaixo e cadastre seu CPF para fazer o check-in.
      </div>
      <label class="flabel">Digite parte do seu nome</label>
      <input type="text" id="nome-busca" placeholder="Ex: João" autocomplete="off" oninput="buscarNome(this.value)">
      <div id="nome-resultados" style="margin-top:10px"></div>
    </div>
  </div>
</div>

<!-- ── MODAL: confirmar dados (membro com CPF já cadastrado) ─── -->
<div class="overlay" id="modal-confirmar" style="display:none">
  <div class="modal">
    <div style="font-size:34px;text-align:center;margin-bottom:10px">✅</div>
    <p style="font-weight:700;font-size:17px;margin-bottom:14px;text-align:center">Confirme seus dados</p>
    <div class="drow"><span class="dl">Nome</span><span class="dv" id="mc-nome"></span></div>
    <div class="drow"><span class="dl">CPF</span><span class="dv" id="mc-cpf"></span></div>
    <div id="mc-err" class="msg-err" style="display:none"></div>
    <div class="btn-row">
      <button class="bc" onclick="fecharModal()">Cancelar</button>
      <button class="bg" onclick="confirmarPresenca()">Confirmar ✓</button>
    </div>
  </div>
</div>

<!-- ── MODAL: cadastrar CPF (membro sem CPF) ──────────────── -->
<div class="overlay" id="modal-cadastrar-cpf" style="display:none">
  <div class="modal">
    <div style="font-size:34px;text-align:center;margin-bottom:10px">📋</div>
    <p style="font-weight:700;font-size:17px;margin-bottom:6px;text-align:center">Cadastrar seu CPF</p>
    <p style="font-size:13px;color:#666;text-align:center;margin-bottom:14px">
      Olá, <strong id="cc-nome"></strong>!<br>
      Para confirmar sua presença, precisamos registrar seu CPF.
    </p>
    <label class="flabel">Seu CPF</label>
    <input type="text" id="cc-cpf" inputmode="numeric" placeholder="000.000.000-00" maxlength="14" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore data-form-type="other" name="documento-confirma">
    <div id="cc-err" class="msg-err" style="display:none"></div>
    <div class="btn-row">
      <button class="bc" onclick="fecharModal()">Cancelar</button>
      <button class="bg" id="btn-cc" onclick="cadastrarCPF()">Salvar CPF e confirmar ✓</button>
    </div>
  </div>
</div>

<!-- ── TELA SUCESSO ────────────────────────────────────────── -->
<div id="tela-ok" style="display:none;width:100%;max-width:420px">
  <div class="card" style="text-align:center">
    <div style="font-size:62px;margin-bottom:12px">🎉</div>
    <h1 id="ok-nome" style="margin-bottom:8px;font-size:20px"></h1>
    <p style="font-size:14px;color:#666;line-height:1.7">Presença confirmada!<br>Redirecionando para a votação...</p>
    <div class="redirect-bar"><div class="redirect-fill" id="redirect-fill" style="width:0%"></div></div>
    <button class="btn btn-sec" style="margin-top:14px;font-size:13px" onclick="window.location.href='/votar'">Ir agora →</button>
  </div>
</div>

<script>
// ── Config ─────────────────────────────────────────────────────────
(async function(){
  try{
    var c=await(await fetch('/api/config')).json();
    document.body.style.background=c.corFundo||'#f0ede6';
    document.documentElement.style.setProperty('--p',c.corPrimaria||'#185FA5');
    document.documentElement.style.setProperty('--s',c.corSecundaria||'#3B6D11');
    if(c.logoUrl) document.getElementById('logo-wrap').innerHTML='<img id="logo-img" src="'+c.logoUrl+'">';
    document.getElementById('nome-inst').textContent='Check-in — '+(c.nomeInstituicao||'Eleição');
  }catch(e){}
  // Garante que os campos de CPF NÃO fiquem mascarados (alguns navegadores/gerenciadores escondem)
  ['cpf-in','cc-cpf'].forEach(function(id){
    var el=document.getElementById(id);
    if(el){
      el.style.webkitTextSecurity='none';
      el.style.textSecurity='none';
      el.setAttribute('type','text');
    }
  });
})();

// ── Utilitários ────────────────────────────────────────────────────
function fmtCPF(v){
  var d=v.replace(/\D/g,'');
  if(d.length>9)  d=d.slice(0,3)+'.'+d.slice(3,6)+'.'+d.slice(6,9)+'-'+d.slice(9);
  else if(d.length>6) d=d.slice(0,3)+'.'+d.slice(3,6)+'.'+d.slice(6);
  else if(d.length>3) d=d.slice(0,3)+'.'+d.slice(3);
  return d.slice(0,14);
}
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function msg(elId, text, type){
  var el=document.getElementById(elId);
  if(!el)return;
  el.className=type==='ok'?'msg-ok':'msg-err';
  el.textContent=text;
  el.style.display='block';
}
function hideMsg(elId){ var el=document.getElementById(elId); if(el) el.style.display='none'; }

// Bind CPF inputs
document.getElementById('cpf-in').addEventListener('input',function(e){e.target.value=fmtCPF(e.target.value);});
document.getElementById('cpf-in').addEventListener('keydown',function(e){if(e.key==='Enter')buscarCPF();});
document.getElementById('cc-cpf').addEventListener('input',function(e){e.target.value=fmtCPF(e.target.value);});
document.getElementById('cc-cpf').addEventListener('keydown',function(e){if(e.key==='Enter')cadastrarCPF();});

var _cpfAtual='', _membroSel=null, _debTimer=null;

// ── Fluxo 1: Busca por CPF ─────────────────────────────────────────
async function buscarCPF(){
  var cpf=(document.getElementById('cpf-in').value||'').trim();
  hideMsg('msg-cpf');
  if(cpf.replace(/\D/g,'').length<11){
    msg('msg-cpf','Digite um CPF completo com 11 dígitos.','err'); return;
  }
  var btn=document.getElementById('btn-cpf');
  btn.disabled=true; btn.textContent='Buscando...';
  try{
    var r=await fetch('/api/checkin/buscar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cpf:cpf})});
    var d=await r.json();
    btn.disabled=false; btn.textContent='Confirmar presença';

    if(d.naoEncontrado){
      // CPF não está em nenhum cadastro — mostra busca por nome
      msg('msg-cpf','CPF não encontrado. Procure seu nome abaixo.','err');
      document.getElementById('div-nome').style.display='block';
      document.getElementById('painel-nome').style.display='block';
      document.getElementById('nome-busca').focus();
      return;
    }
    if(d.error){ msg('msg-cpf',d.error,'err'); return; }
    if(d.jaPresente){
      msg('msg-cpf','✓ Você já está registrado como presente!','ok');
      setTimeout(function(){window.location.href='/votar?cpf='+encodeURIComponent(cpf);},2000);
      return;
    }
    // Abre modal de confirmação
    _cpfAtual=cpf;
    document.getElementById('mc-nome').textContent=d.user.nome;
    document.getElementById('mc-cpf').textContent=d.user.cpf;
    hideMsg('mc-err');
    document.getElementById('modal-confirmar').style.display='flex';
  }catch(e){
    btn.disabled=false; btn.textContent='Confirmar presença';
    msg('msg-cpf','Erro de conexão. Tente novamente.','err');
  }
}

// ── Modal: confirmar presença (membro com CPF) ────────────────────
function fecharModal(){
  document.getElementById('modal-confirmar').style.display='none';
  document.getElementById('modal-cadastrar-cpf').style.display='none';
}
async function confirmarPresenca(){
  hideMsg('mc-err');
  try{
    var r=await fetch('/api/checkin/confirmar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cpf:_cpfAtual})});
    var d=await r.json();
    if(d.error){ msg('mc-err',d.error,'err'); return; }
    fecharModal();
    mostrarSucesso(d.user.nome, _cpfAtual);
  }catch(e){ msg('mc-err','Erro de conexão. Tente novamente.','err'); }
}

// ── Fluxo 2: Busca por nome ────────────────────────────────────────
function buscarNome(q){
  if(_debTimer) clearTimeout(_debTimer);
  _debTimer=setTimeout(function(){ executarBusca(q); },320);
}

async function executarBusca(q){
  var res=document.getElementById('nome-resultados');
  if(!q||q.trim().length<2){
    res.innerHTML='<p style="font-size:12px;color:#aaa;padding:4px 0">Digite ao menos 2 letras.</p>';
    return;
  }
  res.innerHTML='<p style="font-size:12px;color:#aaa;padding:4px 0">Buscando...</p>';
  try{
    var r=await fetch('/api/checkin/buscar-nome?q='+encodeURIComponent(q.trim()));
    var d=await r.json();
    if(!d.users||!d.users.length){
      res.innerHTML='<p style="font-size:12px;color:#aaa;padding:4px 0">Nenhum membro encontrado com esse nome.</p>';
      return;
    }
    res.innerHTML=d.users.map(function(u){
      var badge=u.temCPF
        ?'<span class="cpf-badge tem-cpf">CPF cadastrado</span>'
        :'<span class="cpf-badge sem-cpf">Sem CPF — será cadastrado</span>';
      return '<div class="member-card" data-uid="'+u.id+'" data-nome="'+esc(u.nome)+'" data-temcpf="'+(u.temCPF?'1':'0')+'" onclick="selecionarMembro(this)">'
        +'<div class="member-av">'+esc(u.nome.charAt(0).toUpperCase())+'</div>'
        +'<div>'
          +'<p style="font-size:14px;font-weight:600;line-height:1.3">'+esc(u.nome)+'</p>'
          +badge
        +'</div>'
        +'</div>';
    }).join('');
  }catch(e){
    res.innerHTML='<p style="font-size:12px;color:#a32d2d;padding:4px 0">Erro ao buscar. Tente novamente.</p>';
  }
}

function selecionarMembro(el){
  // Destaca
  document.querySelectorAll('.member-card').forEach(function(c){c.classList.remove('sel');});
  el.classList.add('sel');
  var uid=el.getAttribute('data-uid');
  var nome=el.getAttribute('data-nome');
  var temCPF=el.getAttribute('data-temcpf')==='1';
  _membroSel={id:uid, nome:nome, temCPF:temCPF};

  if(temCPF){
    // Membro já tem CPF — pede para digitar o CPF para verificação de identidade
    document.getElementById('cc-nome').textContent=nome;
    // Reusa o mesmo modal mas com mensagem diferente
    document.querySelector('#modal-cadastrar-cpf p:nth-child(3)').innerHTML=
      'Olá, <strong>'+esc(nome)+'</strong>!<br>Digite seu CPF para confirmar sua identidade e fazer o check-in.';
    document.querySelector('#btn-cc').textContent='Confirmar check-in ✓';
  } else {
    // Membro sem CPF — vai cadastrar
    document.getElementById('cc-nome').textContent=nome;
    document.querySelector('#modal-cadastrar-cpf p:nth-child(3)').innerHTML=
      'Olá, <strong>'+esc(nome)+'</strong>!<br>Para confirmar sua presença, precisamos registrar seu CPF no sistema.';
    document.querySelector('#btn-cc').textContent='Salvar CPF e confirmar ✓';
  }
  document.getElementById('cc-cpf').value='';
  hideMsg('cc-err');
  document.getElementById('modal-cadastrar-cpf').style.display='flex';
  setTimeout(function(){ document.getElementById('cc-cpf').focus(); },100);
}

// ── Modal: cadastrar/confirmar CPF pelo nome ──────────────────────
async function cadastrarCPF(){
  var cpf=(document.getElementById('cc-cpf').value||'').trim();
  hideMsg('cc-err');
  if(cpf.replace(/\D/g,'').length<11){
    msg('cc-err','Digite o CPF completo com 11 dígitos.','err'); return;
  }
  var btn=document.getElementById('btn-cc');
  btn.disabled=true;
  var btnTxt=btn.textContent;
  btn.textContent='Processando...';

  try{
    var r,d;
    if(_membroSel.temCPF){
      // Já tem CPF — verifica CPF digitado e faz check-in via confirmar normal
      r=await fetch('/api/checkin/confirmar-por-id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:_membroSel.id,cpf:cpf})});
    } else {
      // Sem CPF — registra CPF e confirma presença
      r=await fetch('/api/checkin/registrar-cpf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:_membroSel.id,cpf:cpf})});
    }
    d=await r.json();
    btn.disabled=false; btn.textContent=btnTxt;
    if(d.error){ msg('cc-err',d.error,'err'); return; }
    fecharModal();
    mostrarSucesso(d.user.nome, d.user.cpf);
  }catch(e){
    btn.disabled=false; btn.textContent=btnTxt;
    msg('cc-err','Erro de conexão. Tente novamente.','err');
  }
}

// ── Sucesso ────────────────────────────────────────────────────────
function mostrarSucesso(nome, cpf){
  document.getElementById('tela-cpf').style.display='none';
  document.getElementById('ok-nome').textContent=nome+'!';
  document.getElementById('tela-ok').style.display='block';
  requestAnimationFrame(function(){
    requestAnimationFrame(function(){
      document.getElementById('redirect-fill').style.width='100%';
    });
  });
  setTimeout(function(){
    window.location.href='/votar?cpf='+encodeURIComponent(cpf);
  },3000);
}
</script>
</body></html>`;
}


function datashowPage() {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Painel — Eleição</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f1923;color:#fff;min-height:100vh;padding:28px 32px}
h1{font-size:36px;font-weight:900;letter-spacing:-1px;margin-bottom:2px}
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
.slbl{font-size:13px;color:#5a7a96;text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px;font-weight:600}
.sval{font-size:56px;font-weight:900;line-height:1}
.cb{color:#60a5fa}.cg{color:#4ade80}.ca{color:#fbbf24}
.prog-wrap{background:rgba(255,255,255,.07);border-radius:100px;height:12px;overflow:hidden;margin-bottom:6px}
.prog-fill{height:100%;border-radius:100px;background:linear-gradient(90deg,#185FA5,#4ade80);transition:width 1.2s ease}
.prog-lbl{font-size:16px;color:#5a7a96;margin-bottom:20px}
.slbl2{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#5a7a96;font-weight:700;margin-bottom:10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-bottom:20px}
.nv{background:rgba(251,191,36,.07);border:1px solid rgba(251,191,36,.18);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:8px}
.nvd{width:7px;height:7px;border-radius:50%;background:#fbbf24;flex-shrink:0;animation:pulse 2s infinite}
.nvn{font-size:13px;font-weight:600;color:#fde68a}
/* Resultado */
.res-cargo{margin-bottom:20px}
.res-titulo{font-size:26px;font-weight:800;color:#e2e8f0;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.08)}
.res-row{display:flex;align-items:center;gap:16px;margin-bottom:14px}
.res-rank{font-size:20px;color:#5a7a96;min-width:32px;text-align:center}
.res-nome{font-size:22px;font-weight:700;flex:1}
.res-votos{font-size:32px;font-weight:900;min-width:56px;text-align:right}
.res-pct{font-size:20px;color:#5a7a96;min-width:56px;text-align:right}
.res-bar{flex:2;background:rgba(255,255,255,.08);border-radius:100px;height:14px;overflow:hidden}
.res-bar-fill{height:100%;border-radius:100px;transition:width 1s ease}
.eleito{color:#4ade80}.neleito{color:#e2e8f0}
.badge-eleito{background:rgba(74,222,128,.15);color:#4ade80;border:1px solid rgba(74,222,128,.3);font-size:16px;font-weight:700;padding:4px 14px;border-radius:100px}
.branco-row{font-size:17px;color:#5a7a96;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.06)}
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
  <div class="stat"><div class="slbl">Presentes</div><div class="sval cb" id="s1">—</div></div>
  <div class="stat"><div class="slbl">Votaram (cargo atual)</div><div class="sval cg" id="s2">—</div></div>
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

    // Badge de status
    const badge=document.getElementById('badge');
    if(d.elStatus==='ativa'&&d.cargoAtivo){badge.className='badge b-ativa';badge.innerHTML='<div class="dot dl"></div>Votando: '+esc(d.cargoAtivo.nome);}
    else if(d.encerrados&&d.encerrados.length){badge.className='badge b-enc';badge.innerHTML='<div class="dot dy"></div>'+d.encerrados.length+' cargo(s) encerrado(s)';}
    else{badge.className='badge b-agd';badge.innerHTML='<div class="dot dg"></div>Aguardando início';}

    // Stats: presentes / votaram no cargo ativo / aguardando
    const presentes=d.presentes||0;
    const votaram=d.cargoAtivo?d.cargoAtivo.votaram:0;
    const aguardando=d.cargoAtivo?d.cargoAtivo.naoVotaram:0;
    document.getElementById('s1').textContent=presentes;
    document.getElementById('s2').textContent=d.cargoAtivo?votaram:'—';
    document.getElementById('s3').textContent=d.cargoAtivo?aguardando:'—';

    const pct=presentes>0&&d.cargoAtivo?Math.round(votaram/presentes*100):0;
    document.getElementById('prog').style.width=pct+'%';
    document.getElementById('prog-lbl').textContent=d.cargoAtivo
      ?(pct+'% — '+votaram+' de '+presentes+' presentes votaram em '+d.cargoAtivo.nome)
      :(d.encerrados&&d.encerrados.length?'Votação de cargo encerrada — veja os resultados abaixo':'Aguardando início da votação');

    const mc=document.getElementById('main-content');
    let html='';

    // Se há cargo ativo, mostra contagem de quem falta votar
    if(d.elStatus==='ativa'&&d.cargoAtivo){
      if(aguardando===0){
        html+='<div style="text-align:center;padding:28px;font-size:26px;font-weight:800;color:#4ade80">🎉 Todos os presentes já votaram neste cargo!</div>';
      } else {
        html+='<div style="text-align:center;padding:20px">'
          +'<p style="font-size:72px;font-weight:900;color:#fbbf24;line-height:1">'+aguardando+'</p>'
          +'<p style="font-size:20px;color:#8899aa;margin-top:8px">presente'+(aguardando!==1?'s':'')+' ainda aguardando para votar em <strong style="color:#e2e8f0">'+esc(d.cargoAtivo.nome)+'</strong></p>'
          +'</div>';
      }
    }

    // Resultados dos cargos já encerrados
    if(d.encerrados&&d.encerrados.length){
      for(const a of d.encerrados){
        html+='<div class="res-cargo"><div class="res-titulo">'+esc(a.cargo)+' — '+a.vagas+' vaga'+(a.vagas>1?'s':'')+' <span style="font-size:16px;color:#5a7a96;font-weight:600">('+a.votantes+' votaram)</span></div>';
        const maxV=a.rank.length>0?a.rank[0].votos:1;
        a.rank.forEach((r,i)=>{
          const barPct=maxV>0?Math.round(r.votos/maxV*100):0;
          const pctVot=a.votantes>0?Math.round(r.votos/a.votantes*100):0;
          html+='<div class="res-row">'
            +'<span class="res-rank">#'+(i+1)+'</span>'
            +'<span class="res-nome '+(r.eleito?'eleito':'neleito')+'">'+esc(r.nome)+(r.eleito?' <span class="badge-eleito">Eleito ✓</span>':'')+'</span>'
            +'<div class="res-bar"><div class="res-bar-fill" style="width:'+barPct+'%;background:'+(r.eleito?'#4ade80':'#60a5fa')+'"></div></div>'
            +'<span class="res-pct">'+pctVot+'%</span>'
            +'<span class="res-votos '+(r.eleito?'eleito':'neleito')+'">'+r.votos+'</span>'
            +'</div>';
        });
        if(a.branco>0){
          const pb=a.votantes>0?Math.round(a.branco/a.votantes*100):0;
          html+='<div class="branco-row">Votos em branco / nulos: '+a.branco+' ('+pb+'%)</div>';
        }
        html+='<div style="font-size:15px;color:#3d5166;margin-top:6px">Maioria necessária: '+a.maioria+' votos</div>';
        html+='</div>';
      }
    }

    if(!html) html='<div style="text-align:center;padding:32px;color:#3d5166">Aguardando início da votação...</div>';
    mc.innerHTML=html;

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
