const API='/api';
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=d=>d?new Date(d).toLocaleString('en-ZA',{dateStyle:'medium',timeStyle:'short'}):'—';
// RISE COLLECTIVE brand symbol: ring, gold arc, gold tick marks and the figure
const LOGO='<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="31.5" fill="#fff"/><circle cx="32" cy="32" r="26" fill="#fff" stroke="#0f1b3d" stroke-width="3"/><path d="M32 6A26 26 0 0 1 56.4 40.9" fill="none" stroke="#c9a227" stroke-width="3.6" stroke-linecap="round"/><path d="M32 8V15M16.6 13.6L21.1 19M47.4 13.6L42.9 19" stroke="#c9a227" stroke-width="2.4" stroke-linecap="round" fill="none"/><circle cx="32" cy="27" r="4.2" fill="#0f1b3d"/><path d="M32 31.2V43.8M26.2 40.9L32 37.1L37.8 40.9M27.3 48.7L32 43.8L36.7 48.7" stroke="#0f1b3d" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
$$('.logo').forEach(e=>e.innerHTML=LOGO);
const session=()=>{try{return JSON.parse(localStorage.getItem('rise_session'))}catch(e){return null}};
const saveSession=x=>localStorage.setItem('rise_session',JSON.stringify(x));
const logout=()=>{localStorage.removeItem('rise_session');location.href='index.html'};
async function api(path,opts={}){const me=session();const r=await fetch(API+path,{...opts,headers:{'Content-Type':'application/json','x-admin-id':(me&&me.id)||'',...(opts.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'Server error');return d}
function guard(role){const u=session();const staff=r=>r==='admin'||r==='lecturer'||r==='tutor';const ok=u&&(staff(role)?staff(u.role):u.role===role);if(!ok){logout();return null}const w=$('#who');if(w)w.textContent=u.name;return u}
const readFile=f=>new Promise((res,rej)=>{if(!f)return res(null);if(f.size>1.5e6)return rej('File too large (max 1.5MB).');const r=new FileReader();r.onload=()=>res({name:f.name,data:r.result});r.onerror=()=>rej('Could not read file.');r.readAsDataURL(f)});
const fileLink=f=>f?`<a class="btn sm" href="${f.data}" download="${esc(f.name)}">⬇ ${esc(f.name)}</a>`:'';
// Junior tutors: hide the "Learners" tab (the server also refuses learner management)
function hideTutorTabs(){const u=session();if(!u||u.role!=='tutor')return;$$('button').forEach(b=>{const t=b.textContent.trim();if(t.length<25&&/learners/i.test(t))b.style.display='none'})}
// Admins and lecturers: shortcut to the registered junior tutors page
function addTutorLink(){const u=session();if(!u||(u.role!=='admin'&&u.role!=='lecturer')||!/lecturer\.html/.test(location.pathname)||$('#tutorsLink'))return;const a=document.createElement('a');a.id='tutorsLink';a.href='tutors.html';a.className='btn';a.textContent='👥 Junior Tutors';a.style.cssText='position:fixed;right:14px;bottom:14px;box-shadow:0 2px 8px #0004;z-index:50';document.body.appendChild(a)}
// ADMIN ONLY: shortcut to the video day pass requests
function addPassLink(){const u=session();if(!u||u.role!=='admin'||!/lecturer\.html/.test(location.pathname)||$('#passLink'))return;const a=document.createElement('a');a.id='passLink';a.href='passes.html';a.className='btn';a.textContent='💳 Day Passes';a.style.cssText='position:fixed;right:14px;bottom:62px;box-shadow:0 2px 8px #0004;z-index:50';document.body.appendChild(a)}
// ADMIN ONLY: shortcut to the sharing report, with a red count when someone is flagged
function addShareLink(){const u=session();if(!u||u.role!=='admin'||!/lecturer\.html/.test(location.pathname)||$('#shareLink'))return;const a=document.createElement('a');a.id='shareLink';a.href='sharing.html';a.className='btn';a.textContent='🚩 Sharing Report';a.style.cssText='position:fixed;right:14px;bottom:110px;box-shadow:0 2px 8px #0004;z-index:50';document.body.appendChild(a);api('/admin/sharing').then(d=>{if(d.flagged>0){a.textContent='🚩 Sharing Report ('+d.flagged+')';a.style.background='#c0392b';a.style.color='#fff'}}).catch(()=>{})}
// Everyone logged in: shortcut to the notes and videos page
function addResLink(){const u=session();if(!u||!/(lecturer|learner)\.html/.test(location.pathname)||$('#resLink'))return;const a=document.createElement('a');a.id='resLink';a.href='resources.html';a.className='btn';a.textContent='📚 Notes & Videos';a.style.cssText='position:fixed;left:14px;bottom:14px;box-shadow:0 2px 8px #0004;z-index:50';document.body.appendChild(a)}
function addLinks(){hideTutorTabs();addTutorLink();addPassLink();addShareLink();addResLink()}
document.addEventListener('DOMContentLoaded',addLinks);window.addEventListener('load',addLinks);
