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
// The error message now includes the HTTP status code when the server did not send its own message.
// When a learner opens a subject, the tutors of that subject are shown at the top right.
async function api(path,opts={}){const me=session();const r=await fetch(API+path,{...opts,headers:{'Content-Type':'application/json','x-admin-id':(me&&me.id)||'',...(opts.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||('Server error ('+r.status+')'));
 try{if(me&&me.role==='learner'&&/^\/resources\?subject=/.test(path))showSubjectTutors(decodeURIComponent(path.split('subject=')[1].split('&')[0]))}catch(e){}
 return d}
function guard(role){const u=session();const staff=r=>r==='admin'||r==='lecturer'||r==='tutor';const ok=u&&(staff(role)?staff(u.role):u.role===role);if(!ok){logout();return null}const w=$('#who');if(w)w.textContent=u.name;return u}
const readFile=f=>new Promise((res,rej)=>{if(!f)return res(null);if(f.size>1.5e6)return rej('File too large (max 1.5MB).');const r=new FileReader();r.onload=()=>res({name:f.name,data:r.result});r.onerror=()=>rej('Could not read file.');r.readAsDataURL(f)});
const fileLink=f=>f?`<a class="btn sm" href="${f.data}" download="${esc(f.name)}">⬇ ${esc(f.name)}</a>`:'';

// Junior tutors: hide the "Learners" tab and square (the server also refuses learner management)
function hideTutorTabs(){const u=session();if(!u||u.role!=='tutor')return;$$('button').forEach(b=>{const t=b.textContent.trim();if(t.length<25&&/learners/i.test(t))b.style.display='none'});$$('.tile[data-t="lp"]').forEach(t=>t.style.display='none')}

// Pictures behind some of the home-screen squares (admin, lecturer and tutor home page). Squares without a picture keep their normal look.
const TILE_PICS={profileLink:'profile.avif',topLink:'top_5_in_districts.jpg',compStaffLink:'competition.jpg',compRegLink:'competition.jpg',resLink:'subjects.avif'};
(function(){const s=document.createElement('style');s.textContent='.tile.pic{position:relative;overflow:hidden;background-size:cover;background-position:center;color:#fff;min-height:150px}.tile.pic::before{content:"";position:absolute;inset:0;z-index:0;background:linear-gradient(to top,rgba(10,18,45,.88),rgba(10,18,45,.4) 60%,rgba(10,18,45,.2))}.tile.pic>*{position:relative;z-index:1}.tile.pic h3,.tile.pic p,.tile.pic .count{color:#fff}.tile.pic .ico{text-shadow:0 1px 3px rgba(0,0,0,.6)}';document.head.appendChild(s)})();

// Adds one large square to the home screen (only on pages that have a .tiles grid)
function addTile(id,href,ico,title,desc){const box=$('.tiles');if(!box||$('#'+id))return null;const a=document.createElement('a');a.id=id;a.className='tile';a.href=href;a.innerHTML='<span class="ico">'+ico+'</span><div><div class="count" hidden></div><h3>'+title+'</h3><p>'+desc+'</p></div>';if(TILE_PICS[id]){a.classList.add('pic');a.style.backgroundImage="url('"+TILE_PICS[id]+"'),linear-gradient(135deg,#0f1b3d,#3b82f6)"}box.appendChild(a);return a}

function addLinks(){try{addLinksInner()}catch(e){console.error('addLinks:',e)}}
function addLinksInner(){
 const u=session();if(!u)return;
 const onLec=/lecturer\.html/.test(location.pathname),onLrn=/learner\.html/.test(location.pathname),onAny=onLec||onLrn;
 const mgr=u.role==='admin'||u.role==='lecturer';
 // Admins, lecturers and junior tutors: own profile (picture, description, gender, learner numbers)
 if(onLec)addTile('profileLink','profile.html','🙂','My Profile','Picture, about me and your learners');
 // Admins and lecturers: registered tutoring teachers
 if(onLec&&mgr)addTile('tutorsLink','tutors.html','👥','Tutoring Teachers','Registered tutoring teachers');
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

// Subject pictures: puts a picture behind each subject box on subjects.html.
// Subjects without a picture keep their normal look.
const SUBJECT_PICS={
 'business studies':['business-studies.jpg','Business_studies.jpg'],
 'economics':['economics.webp'],
 'accounting':['accounting.jpg'],
 'life sciences':['life-sciences.jpg','life_science.jpg'],
 'physics':['physics.webp','teacher-maths-physic.webp'],
 'physical sciences':['physics.webp','teacher-maths-physic.webp'],
 'technical sciences':['physics.webp','teacher-maths-physic.webp'],
 'maths':['maths.webp'],
 'mathematical literacy':['maths.webp'],
 'technical mathematics':['maths.webp']
};
// Each picture is looked for in /images and in the main folder; the ones that exist are drawn.
const picUrls=files=>files.flatMap(f=>['/images/'+f,'/'+f]).map(u=>'url('+u+')').join(',');
function addSubjectPics(){try{addSubjectPicsInner()}catch(e){console.error('subject pictures:',e)}}
function addSubjectPicsInner(){
 if(!/subjects\.html/.test(location.pathname))return;
 const key=el=>el.textContent.trim().toLowerCase();
 $$('h1,h2,h3,h4,h5,b,strong,span,p,div,a').forEach(el=>{
  if(el.children.length)return;
  const pic=SUBJECT_PICS[key(el)];
  if(!pic)return;
  let box=el.closest('a,.tile,.card,button,li,[class*=subject]')||el.parentElement;
  // If that box holds several subjects, use the nearest parent instead
  const inside=[...box.querySelectorAll('*')].filter(x=>!x.children.length&&SUBJECT_PICS[key(x)]).length;
  if(inside>1)box=el.parentElement;
  if(!box||box.dataset.pic)return;
  box.dataset.pic='1';
  box.style.backgroundImage='linear-gradient(rgba(15,27,61,.55),rgba(15,27,61,.78)),'+picUrls(pic);
  box.style.backgroundSize='cover';
  box.style.backgroundPosition='center';
  box.style.color='#fff';
  box.style.minHeight=box.style.minHeight||'140px';
  [box,...box.querySelectorAll('*')].forEach(x=>{x.style.color='#fff'});
 });
}
document.addEventListener('DOMContentLoaded',addSubjectPics);
window.addEventListener('load',addSubjectPics);
// The subject boxes are drawn after the page loads, so look again for a few seconds (subjects page only)
if(/subjects\.html/.test(location.pathname)){let n=0;const t=setInterval(()=>{addSubjectPics();if(++n>=20)clearInterval(t)},500)}

// Tutor profile at the top right of a subject (learners and parents).
// Shows the tutors who teach this subject at the learner's school. Press one to read the profile.
function removeTutorBadge(){const b=document.getElementById('tutorBadge');if(b)b.remove()}
async function showSubjectTutors(subject){
 try{
  const d=await api('/subject-tutors?subject='+encodeURIComponent(subject));
  removeTutorBadge();
  if(!d.tutors||!d.tutors.length)return;
  const box=document.createElement('div');
  box.id='tutorBadge';
  box.style.cssText='position:fixed;top:68px;right:10px;z-index:60;display:flex;flex-direction:column;align-items:flex-end;gap:6px';
  d.tutors.forEach(t=>{
   const b=document.createElement('button');
   b.type='button';
   b.title='Tutor profile';
   b.style.cssText='display:flex;align-items:center;gap:8px;max-width:210px;padding:4px 12px 4px 4px;border:1px solid #cfd6e6;border-radius:999px;background:#fff;color:#0f1b3d;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer;font:600 .85rem system-ui,sans-serif';
   b.appendChild(tutorAvatar(t,38));
   const n=document.createElement('span');
   n.textContent=t.name;
   n.style.cssText='overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
   b.appendChild(n);
   b.onclick=()=>showTutorCard(t);
   box.appendChild(b);
  });
  document.body.appendChild(box);
 }catch(e){}
}
function tutorAvatar(t,size){
 if(t.photo){const i=document.createElement('img');i.src=t.photo;i.alt='';i.style.cssText='width:'+size+'px;height:'+size+'px;border-radius:50%;object-fit:cover;flex:none';return i}
 const s=document.createElement('span');
 s.textContent=(t.name||'?').trim().charAt(0).toUpperCase();
 s.style.cssText='width:'+size+'px;height:'+size+'px;border-radius:50%;background:#0f1b3d;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex:none';
 return s;
}
function showTutorCard(t){
 const o=document.createElement('div');
 o.style.cssText='position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px';
 const c=document.createElement('div');
 c.style.cssText='background:#fff;color:#111;border-radius:14px;max-width:380px;width:100%;padding:22px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.4)';
 c.onclick=e=>e.stopPropagation();
 const av=tutorAvatar(t,110);av.style.margin='0 auto 12px';av.style.display=t.photo?'block':'flex';
 const h=document.createElement('h3');h.textContent=t.name;h.style.margin='0';
 const p=document.createElement('p');p.textContent='Tutor for '+(t.subject||'this subject');p.style.cssText='margin:4px 0 12px;color:#555';
 const bio=document.createElement('p');bio.textContent=t.bio||'This tutor has not added a description yet.';bio.style.cssText='white-space:pre-wrap;text-align:left;margin:0 0 16px';
 const x=document.createElement('button');x.type='button';x.className='btn';x.textContent='Close';x.onclick=()=>o.remove();
 c.append(av,h,p,bio,x);o.appendChild(c);o.onclick=()=>o.remove();
 document.body.appendChild(o);
}
// Leaving a subject (Back, Home, Subjects) removes the tutor profile from the screen
document.addEventListener('click',e=>{
 const el=e.target.closest&&e.target.closest('a,button');
 if(!el||el.closest('#tutorBadge'))return;
 const t=(el.textContent||'').trim();
 if(/^←|back|home|subjects$/i.test(t))setTimeout(removeTutorBadge,50);
});

// Parent logins are view-only: show a banner and switch off buttons that add or change anything.
// (The server also refuses every change made by a parent.)
function parentView(){
 const u=session();if(!u||!u.parent)return;
 if(!$('#parentBar')&&document.body){const b=document.createElement('div');b.id='parentBar';b.style.cssText='background:#c9a227;color:#0f1b3d;text-align:center;padding:6px 10px;font-weight:600;font-size:.9rem';b.textContent='Parent view: you can look, but not change anything.';document.body.prepend(b)}
 $$('button,input[type=submit],input[type=file]').forEach(b=>{if(b.closest('header')||b.closest('#tutorBadge'))return;const t=(b.textContent||b.value||'').trim();if(b.type==='file'||/\b(submit|register|request|upload|send|pay|save|delete|add|post|mark)/i.test(t)){b.disabled=true;b.title='Parents have view-only access'}});
}
document.addEventListener('DOMContentLoaded',parentView);window.addEventListener('load',parentView);
setInterval(parentView,1500);

// Home-screen squares: hide the little corner symbols, and show every square title in CAPITAL LETTERS and italics
(function(){const s=document.createElement('style');s.textContent='.tile .ico,.ptile .ico{display:none!important}.tile h3,.ptile h3{text-transform:uppercase!important;font-style:italic!important}';document.head.appendChild(s)})();
