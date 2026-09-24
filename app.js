const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const DB={get(k){try{return JSON.parse(localStorage.getItem('rise_'+k))||[]}catch(e){return[]}},set(k,v){try{localStorage.setItem('rise_'+k,JSON.stringify(v))}catch(e){alert('Storage full – use smaller files.')}}};
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=d=>d?new Date(d).toLocaleString('en-ZA',{dateStyle:'medium',timeStyle:'short'}):'—';
const LOGO='<svg viewBox="0 0 64 64"><rect x="24" y="2" width="16" height="14" rx="3" fill="#c9a227"/><rect x="24" y="48" width="16" height="14" rx="3" fill="#c9a227"/><circle cx="32" cy="32" r="18" fill="#0f1b3d" stroke="#c9a227" stroke-width="3"/><path d="M32 32V21M32 32l8 4" stroke="#fff" stroke-width="2.5" stroke-linecap="round" fill="none"/><circle cx="32" cy="32" r="2" fill="#c9a227"/></svg>';
$$('.logo').forEach(e=>e.innerHTML=LOGO);
if(!DB.get('users').length)DB.set('users',[{id:'u0',name:'Lecturer Admin',email:'admin@rise.com',pass:'admin123',role:'lecturer'}]);
const me=()=>{try{return JSON.parse(localStorage.getItem('rise_session'))}catch(e){return null}};
function guard(role){const u=me(),r=u&&DB.get('users').find(x=>x.id===u.id);if(!u||!r||u.role!==role||r.status==='blocked'||r.status==='pending'){localStorage.removeItem('rise_session');location.href='index.html';return null}$('#who').textContent=u.name;return u}
function logout(){localStorage.removeItem('rise_session');location.href='index.html'}
const readFile=f=>new Promise((res,rej)=>{if(!f)return res(null);if(f.size>1.5e6)return rej('File too large (max 1.5MB).');const r=new FileReader();r.onload=()=>res({name:f.name,data:r.result});r.readAsDataURL(f)});
const fileLink=f=>f?`<a class="btn sm" href="${f.data}" download="${esc(f.name)}">⬇ ${esc(f.name)}</a>`:'';
