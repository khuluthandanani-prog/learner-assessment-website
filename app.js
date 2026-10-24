const API='/api';
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=d=>d?new Date(d).toLocaleString('en-ZA',{dateStyle:'medium',timeStyle:'short'}):'—';
// Logo: full logo on the login page, round emblem in the page headers
const LOGO_FULL='<img src="logo.jpg" alt="RISE COLLECTIVE" style="display:block;width:240px;max-width:85%;height:auto;margin:0 auto;border-radius:10px">';
const LOGO_ICON='<img src="logo-icon.png" alt="RISE COLLECTIVE" style="display:block;width:44px;height:44px;border-radius:50%;background:#fff;padding:2px;object-fit:cover">';
$$('.logo').forEach(e=>{
  if(e.classList.contains('big')){
    e.innerHTML=LOGO_FULL;
    // the full logo already contains the RISE COLLECTIVE name, so hide the duplicate heading
    const n=e.nextElementSibling;if(n&&n.tagName==='H1')n.style.display='none';
  }else e.innerHTML=LOGO_ICON;
});
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
// Everyone logged in: shortcut to the notes and videos page
function addResLink(){const u=session();if(!u||!/(lecturer|learner)\.html/.test(location.pathname)||$('#resLink'))return;const a=document.createElement('a');a.id='resLink';a.href='resources.html';a.className='btn';a.textContent='📚 Notes & Videos';a.style.cssText='position:fixed;left:14px;bottom:14px;box-shadow:0 2px 8px #0004;z-index:50';document.body.appendChild(a)}
function addLinks(){hideTutorTabs();addTutorLink();addResLink()}
document.addEventListener('DOMContentLoaded',addLinks);window.addEventListener('load',addLinks);
