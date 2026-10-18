from pathlib import Path
import base64,hashlib,re,json,zipfile
root=Path('output/lakelife-ui-preview')
dist=root/'dist'
assets={}
for p in (dist/'assets').iterdir():
 mime={'.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}[p.suffix]
 assets[p.name]=f'data:{mime};base64,'+base64.b64encode(p.read_bytes()).decode()
css=(dist/'styles.css').read_text()
for n,data in assets.items():
 css=css.replace(f"url('assets/{n}')",f"url('{data}')")
js='window.LakeAssets='+json.dumps(assets,separators=(',',':'))+';\n'
for name in ['public.js','portals.js','app.js']:
 part=(dist/name).read_text()
 part=part.replace('src="assets/${name}.svg"','src="${LakeAssets[name+\'.svg\']}"')
 for n,data in assets.items():
  part=part.replace(f'src="assets/{n}"',f'src="{data}"')
 js+=part+'\n'
# Only this exact inlined script is allowed. Forms and connections remain blocked.
hash_value=base64.b64encode(hashlib.sha256(js.encode()).digest()).decode()
html=(dist/'index.html').read_text()
html=re.sub(r'<meta http-equiv="Content-Security-Policy" content="[^"]+">',f'''<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'sha256-{hash_value}'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'">''',html)
html=html.replace('<link rel="icon" href="assets/lakelife-mark.svg">',f'<link rel="icon" href="{assets["lakelife-mark.svg"]}">')
html=html.replace('<link rel="stylesheet" href="styles.css">','<style>'+css+'</style>')
html=re.sub(r'<script src="(?:public|portals|app)\.js" defer></script>','',html)
# Run after the DOM exists; no external dependencies or imports.
html=html.replace('</body>','<script>'+js+'</script></body>')
(root/'LakeLife-UI-Preview.html').write_text(html)
print('Saved self-contained offline preview:',len(html),'bytes')
