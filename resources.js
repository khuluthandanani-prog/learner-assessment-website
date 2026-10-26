// EDIT THIS LIST: one line per item. type is 'note' or 'video'.
const RESOURCES=[
 {type:'note',title:'Example: Course notes (PDF)',desc:'Replace this with your own note',link:'https://example.com/notes.pdf'},
 {type:'video',title:'Example: Lesson 1 video',desc:'Replace this with your own video',link:'https://www.youtube.com/watch?v=VIDEO_ID'}
];
function renderResources(el){
 el.innerHTML=RESOURCES.length?RESOURCES.map(r=>`<div class="card"><div class="row"><h3>${r.type==='video'?'🎥':'📄'} ${esc(r.title)}</h3><span class="tag">${r.type==='video'?'Video':'Notes'}</span></div><p>${esc(r.desc||'')}</p><a class="btn sm" href="${esc(r.link)}" target="_blank" rel="noopener">${r.type==='video'?'Watch':'Open'}</a></div>`).join(''):'<p class="m">No notes or videos yet.</p>';
}
