#!/bin/bash
# Probe: download Bubble Foam Frenzy builds (Classic = Sept 7 checkpoint, Current = published) and report what they need
mkdir -p /out; ( cd /out && python3 -m http.server ${PORT:-8080} ) &
cd /tmp && rm -rf bf && mkdir bf && cd bf
grab() { # $1 name $2 url
  mkdir -p $1 && cd $1
  curl -sSL "$2/" -o index.html; echo "== $1 index.html $(wc -c < index.html) bytes"
  cat index.html | head -c 3000; echo
  for a in $(grep -oE '(src|href)="/[^"]+"' index.html | sed -E 's/.*="\/([^"]+)"/\1/'); do
    mkdir -p "$(dirname "$a")"; curl -sSL "$2/$a" -o "$a"; echo "asset $a $(wc -c < "$a")"
  done
  for js in $(find . -name '*.js'); do
    echo "-- $js: dynamic imports:"; grep -oE 'assets/[A-Za-z0-9_.-]+\.(js|css|png|svg|mp3|wav|webp)' "$js" | sort -u | head -40
    echo "-- $js: base44 hosts:"; grep -oE 'https?://[a-zA-Z0-9.-]*base44[a-zA-Z0-9./_-]*' "$js" | sort -u | head -20
    echo "-- $js: badge/branding hits:"; grep -oE '.{60}(Made with|Built with|Edit with|base44 badge|Base44)[^"]{0,60}' "$js" | head -8
    echo "-- $js: entity/auth calls:"; grep -oE '.{40}(entities\.Score|auth\.me|redirectToLogin|requiresAuth)[^;]{0,60}' "$js" | head -8
  done
  cd ..
}
grab classic "https://checkpoint--6a9d20686a8e8203f92cf3ed--6a9ea0d2135302727636d0ca.base44.app"
grab current "https://pop-foam-frenzy.base44.app"
du -sh classic current
tar czf /out/bubble-sources.tgz classic current
echo "STAGE PROBE_DONE"
sleep infinity
