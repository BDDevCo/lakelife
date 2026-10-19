/* Static template/asset check. This does not launch or substitute for a browser. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),dist=path.join(root,'dist'),repo=path.resolve(root,'../..');
const read=n=>fs.readFileSync(path.join(dist,n),'utf8');
const initial={confirmedExtra:0,report:{amount:100,method:'Cash at the office',date:'2026-10-15',status:'pending'},requests:[],seasonal:'suggested'};
const fresh={window:{},Intl,LakeEscape:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))};
function load(publicJS,portalJS){const c=vm.createContext({...fresh,window:{}});vm.runInContext(publicJS,c);c.LakePublic=c.window.LakePublic;vm.runInContext(portalJS,c);return c.window;}
const old=n=>cp.execFileSync('git',['show','758ea52:output/lakelife-ui-preview/dist/'+n],{cwd:repo,encoding:'utf8'});
const current=load(read('public.js'),read('portals.js')),previous=load(old('public.js'),old('portals.js'));
const routes=[...read('app.js').match(/const validRoutes=\[(.*?)\];/s)[1].matchAll(/'([^']+)'/g)].map(x=>x[1]);
const strip=s=>s.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const checked=[];
for(const route of routes){
 const [role,page]=route.split('/');const portal=['park','renter','homeowner'].includes(role);
 const render=o=>portal?o.LakePortals.render(role,page,initial):o.LakePublic.render(role);
 const html=render(current),before=render(previous);
 assert.equal(strip(html),strip(before),'Visible text changed: '+route);
 assert.equal((html.match(/<h1\b/g)||[]).length,1);
 const paths=[...html.matchAll(/src="assets\/([^"]+)"/g)].map(m=>m[1]);
 for(const name of paths)assert(fs.existsSync(path.join(dist,'assets',name)),'Missing '+name);
 if(['home','marketing','portal','for-parks','get-started','park','renter'].includes(route))assert(paths.includes('park-homes.svg'),'Missing audience pair '+route);
 assert(!paths.includes('renter.svg'),'Old generic RV-only reference '+route);
 checked.push({route,visible_copy_preserved:true,all_image_references_resolve:true});
}
assert.equal(read('app.js'),old('app.js'),'Preview interaction code changed');
for(const name of ['rv.svg','mobile-home.svg','renter.svg','lake-morning.png','house.svg','clean.svg','lakelife-logo.svg']){
 const before=cp.execFileSync('git',['show','758ea52:output/lakelife-ui-preview/dist/assets/'+name],{cwd:repo,maxBuffer:12*1024*1024});assert(before.equals(fs.readFileSync(path.join(dist,'assets',name))),'Approved master changed: '+name);
}
const single=fs.readFileSync(path.join(root,'LakeLife-UI-Preview.html'),'utf8'),script=single.match(/<script>([\s\S]*?)<\/script>/)[1];
assert(single.includes('sha256-'+crypto.createHash('sha256').update(script).digest('base64')),'CSP mismatch');
for(const name of ['park-homes.svg','rv.svg','mobile-home.svg','lake-morning.png'])assert(single.includes(fs.readFileSync(path.join(dist,'assets',name)).toString('base64')),'Embedded asset absent '+name);
new vm.Script(script);
const result={date:'2026-10-18',kind:'Static artwork verification',browser_review:'Not rerun: local-file browser access unavailable. Earlier browser checks are historical.',routes:checked,approved_master_files_preserved:true,interaction_code_unchanged:true,single_file_assets_and_CSP_match:true};
fs.writeFileSync(path.join(root,'artwork-refresh-checks.json'),JSON.stringify(result,null,2)+'\n');console.log('31 templates: copy preserved; current artwork resolves; approved masters and interactions unchanged; embedded preview verified.');
