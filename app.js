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
// The error message now includes the HTTP status code when the server did not send its own message
async function api(path,opts={}){const me=session();const r=await fetch(API+path,{...opts,headers:{'Content-Type':'application/json','x-admin-id':(me&&me.id)||'',...(opts.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||('Server error ('+r.status+')'));return d}
function guard(role){const u=session();const staff=r=>r==='admin'||r==='lecturer'||r==='tutor';const ok=u&&(staff(role)?staff(u.role):u.role===role);if(!ok){logout();return null}const w=$('#who');if(w)w.textContent=u.name;return u}
const readFile=f=>new Promise((res,rej)=>{if(!f)return res(null);if(f.size>1.5e6)return rej('File too large (max 1.5MB).');const r=new FileReader();r.onload=()=>res({name:f.name,data:r.result});r.onerror=()=>rej('Could not read file.');r.readAsDataURL(f)});
const fileLink=f=>f?`<a class="btn sm" href="${f.data}" download="${esc(f.name)}">⬇ ${esc(f.name)}</a>`:'';

// Junior tutors: hide the "Learners" tab and square (the server also refuses learner management)
function hideTutorTabs(){const u=session();if(!u||u.role!=='tutor')return;$$('button').forEach(b=>{const t=b.textContent.trim();if(t.length<25&&/learners/i.test(t))b.style.display='none'});$$('.tile[data-t="lp"]').forEach(t=>t.style.display='none')}

// Adds one large square to the home screen (only on pages that have a .tiles grid)
function addTile(id,href,ico,title,desc){const box=$('.tiles');if(!box||$('#'+id))return null;const a=document.createElement('a');a.id=id;a.className='tile';a.href=href;a.innerHTML='<span class="ico">'+ico+'</span><div><div class="count" hidden></div><h3>'+title+'</h3><p>'+desc+'</p></div>';box.appendChild(a);return a}

function addLinks(){
 const u=session();if(!u)return;
 const onLec=/lecturer\.html/.test(location.pathname),onLrn=/learner\.html/.test(location.pathname),onAny=onLec||onLrn;
 const mgr=u.role==='admin'||u.role==='lecturer';
 // Admins, lecturers and junior tutors: own profile (picture, description, gender, learner numbers)
 if(onLec)addTile('profileLink','profile.html','🙂','My Profile','Picture, about me and your learners');
 // Admins and lecturers: registered junior tutors
 if(onLec&&mgr)addTile('tutorsLink','tutors.html','👥','Junior Tutors','Registered junior tutors');
 // Admins and lecturers: learner and tutor applications, red count when some are waiting
 if(onLec&&mgr){const a=addTile('appLink','applications.html','📨','Applications','Learner and tutor applications');if(a)api('/admin/applications').then(d=>{const n=d.applications.filter(x=>x.status==='pending').length;if(n>0){const c=$('.count',a);c.textContent=n;c.hidden=false}}).catch(()=>{})}
 // Admin only: video day pass requests
 if(onLec&&u.role==='admin')addTile('passLink','passes.html','💳','Day Passes','Video day pass requests');
 // Admin only: sharing report, with a red count when someone is flagged
 if(onLec&&u.role==='admin'){const a=addTile('shareLink','sharing.html','🚩','Sharing Report','Accounts flagged for sharing');if(a)api('/admin/sharing').then(d=>{if(d.flagged>0){const c=$('.count',a);c.textContent=d.flagged;c.hidden=false;a.style.borderColor='#c0392b'}}).catch(()=>{})}
 // Everyone logged in: subjects (notes and videos for each subject)
 if(onAny)addTile('resLink','subjects.html','📚','Subjects','Notes and videos for each subject');
 // Competitions: learners register and write; admin and lecturers set papers and see marks
 if(onLrn)addTile('compLink','comp.html','🏅','Competitions','Register and write competition papers');
 if(onLec&&mgr)addTile('compStaffLink','comp-staff.html','🏅','Competition Papers','Set papers and see marks');
 // Top 5 in each district (learners see only their own district)
 if(onLrn||(onLec&&mgr))addTile('topLink','top5.html','🏆','Top 5','Best learners in each district');
 // Admin only: approve competition registrations, red count when some are waiting
 if(onLec&&u.role==='admin'){const a=addTile('compRegLink','comp-regs.html','📋','Competition Registrations','Approve or reject entries');if(a)api('/comp/regs').then(d=>{const n=d.regs.filter(r=>r.status==='pending').length;if(n>0){const c=$('.count',a);c.textContent=n;c.hidden=false}}).catch(()=>{})}
 hideTutorTabs();
}
document.addEventListener('DOMContentLoaded',addLinks);window.addEventListener('load',addLinks);
