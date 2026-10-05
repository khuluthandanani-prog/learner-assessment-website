const API='/api';
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=d=>d?new Date(d).toLocaleString('en-ZA',{dateStyle:'medium',timeStyle:'short'}):'—';
const LOGO='<svg viewBox="0 0 64 64"><rect x="24" y="2" width="16" height="14" rx="3" fill="#c9a227"/><rect x="24" y="48" width="16" height="14" rx="3" fill="#c9a227"/><circle cx="32" cy="32" r="18" fill="#0f1b3d" stroke="#c9a227" stroke-width="3"/><path d="M32 32V21M32 32l8 4" stroke="#fff" stroke-width="2.5" stroke-linecap="round" fill="none"/><circle cx="32" cy="32" r="2" fill="#c9a227"/></svg>';
$$('.logo').forEach(e=>e.innerHTML=LOGO);
const session=()=>{try{return JSON.parse(localStorage.getItem('rise_session'))}catch(e){return null}};
const saveSession=x=>localStorage.setItem('rise_session',JSON.stringify(x));
const logout=()=>{localStorage.removeItem('rise_session');location.href='index.html'};
async function api(path,opts={}){const r=await fetch(API+path,{headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'Server error');return d}
function guard(role){const u=session();if(!u||u.role!==role){logout();return null}$('#who').textContent=u.name;return u}
const readFile=f=>new Promise((res,rej)=>{if(!f)return res(null);if(f.size>1.5e6)return rej('File too large (max 1.5MB).');const r=new FileReader();r.onload=()=>res({name:f.name,data:r.result});r.onerror=()=>rej('Could not read file.');r.readAsDataURL(f)});
const fileLink=f=>f?`<a class="btn sm" href="${f.data}" download="${esc(f.name)}">⬇ ${esc(f.name)}</a>`:'';
