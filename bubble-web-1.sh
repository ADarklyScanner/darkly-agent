#!/bin/bash
# Bubble Foam Frenzy: pull Classic + Frenzy web builds, cut every Base44 tie, and test them in a headless phone browser
mkdir -p /out; ( cd /out && python3 -m http.server ${PORT:-8080} ) &
echo "STAGE START"
REPO=https://codeload.github.com/ADarklyScanner/darkly-agent/tar.gz/refs/heads/build-inputs
W=/work/bubble; rm -rf $W; mkdir -p $W; cd $W
curl -sSL $REPO | tar xz --strip-components=1 --wildcards '*/bubble/*' && ls bubble
grab() { # $1 name $2 url
  mkdir -p web/$1 && cd web/$1
  curl -sSL "$2/" -o index.html
  for a in $(grep -oE '(src|href)="/[^"]+"' index.html | sed -E 's/.*="\/([^"]+)"/\1/' | grep -v badge); do
    mkdir -p "$(dirname "$a")"; curl -sSL "$2/$a" -o "$a"
  done
  cd $W
}
grab classic "https://checkpoint--6a9d20686a8e8203f92cf3ed--6a9ea0d2135302727636d0ca.base44.app"
grab frenzy "https://pop-foam-frenzy.base44.app"
curl -sSL -o web/logo.png "https://media.base44.com/images/public/6a9d20686a8e8203f92cf3ed/35694e1f8_logo.png"

python3 - <<'PY'
import re,glob,shutil
for d in ['classic','frenzy']:
    f=f'web/{d}/index.html'; s=open(f,encoding='utf-8').read()
    s=re.sub(r'<script[^>]*(badge\.js|data-platform-url|data-app-id)[^>]*>\s*</script>','',s,flags=re.S)
    s=re.sub(r'<link[^>]*media\.base44\.com[^>]*/?>','',s)
    s=s.replace('Base44 APP','Bubble Foam Frenzy')
    s=re.sub(r'<head>','<head><script src="/darkly-shim.js"></script>',s,count=1)
    open(f,'w',encoding='utf-8').write(s)
    shutil.copy('bubble/shim.js',f'web/{d}/darkly-shim.js')
    print(d,'base44 mentions left in index.html:',len(re.findall('base44',s,re.I)))
    for js in glob.glob(f'web/{d}/assets/*.js'):
        t=open(js,encoding='utf-8',errors='ignore').read()
        hits=sorted(set(re.findall(r'.{0,30}(?:Game Over|GAME OVER|Time.s up|TIME.S UP|Final Score|Play Again|Try Again|New High|Round Over)[^`"\']{0,20}',t)))
        print(d,'end-of-round text:',hits[:12])
PY
echo "PREP_OK"

# headless phone test
export DEBIAN_FRONTEND=noninteractive
(apt-get update -qq && apt-get install -y -qq nodejs npm > /dev/null) 2>&1 | tail -2
mkdir -p /work/pt && cd /work/pt && npm init -y >/dev/null && npm i -s playwright@1.49.1 >/dev/null 2>&1 && npx -y playwright@1.49.1 install --with-deps chromium > /dev/null 2>&1; echo "PW_INSTALL=$?"
cat > t.js <<'JS'
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
function serve(root, port) {
  return new Promise(r => { http.createServer((q, s) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    let f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
    const ext = path.extname(f); s.setHeader('content-type', {'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.png':'image/png'}[ext]||'application/octet-stream');
    s.end(fs.readFileSync(f)); }).listen(port, r); });
}
(async () => {
  const b = await chromium.launch();
  for (const [name, port] of [['classic', 9101], ['frenzy', 9102]]) {
    await serve('/work/bubble/web/' + name, port);
    const ctx = await b.newContext({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const pg = await ctx.newPage(); const errs = [], ext = new Set();
    pg.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
    pg.on('pageerror', e => errs.push('PAGEERR ' + e.message.slice(0, 160)));
    pg.on('request', r => { const u = new URL(r.url()); if (u.hostname !== 'localhost') ext.add(u.hostname); });
    await pg.goto('http://localhost:' + port + '/'); await pg.waitForTimeout(4000);
    console.log('=== ' + name + ' START SCREEN:', (await pg.innerText('body')).replace(/\s+/g, ' ').slice(0, 600));
    console.log('buttons:', JSON.stringify(await pg.$$eval('button', bs => bs.map(x => x.innerText.trim()).filter(Boolean).slice(0, 20))));
    await pg.screenshot({ path: '/out/shot-' + name + '-1.png' });
    const start = await pg.$('button:has-text("Start"), button:has-text("Play"), button:has-text("Normal")');
    if (start) { await start.click(); await pg.waitForTimeout(800); }
    const again = await pg.$('button:has-text("Start"), button:has-text("Play")'); if (again) { await again.click().catch(()=>{}); }
    for (let i = 0; i < 60; i++) { await pg.mouse.click(60 + (i * 53) % 300, 160 + (i * 97) % 560); await pg.waitForTimeout(60); }
    console.log('=== ' + name + ' AFTER TAPS:', (await pg.innerText('body')).replace(/\s+/g, ' ').slice(0, 500));
    await pg.screenshot({ path: '/out/shot-' + name + '-2.png' });
    await pg.waitForTimeout(65000);
    console.log('=== ' + name + ' AFTER 65s:', (await pg.innerText('body')).replace(/\s+/g, ' ').slice(0, 700));
    console.log('buttons:', JSON.stringify(await pg.$$eval('button', bs => bs.map(x => x.innerText.trim()).filter(Boolean).slice(0, 20))));
    await pg.screenshot({ path: '/out/shot-' + name + '-3.png' });
    console.log('saved scores on phone:', await pg.evaluate(() => localStorage.getItem('darkly_bubble_scores_v1')));
    console.log('outside hosts contacted:', JSON.stringify([...ext]));
    console.log('errors:', JSON.stringify(errs.slice(0, 12)));
    await ctx.close();
  }
  await b.close();
})().catch(e => console.log('TESTFAIL', e.message));
JS
node t.js
cd /work/bubble && tar czf /out/bubble-web-ready.tgz web
echo "STAGE WEB_DONE"
sleep infinity
