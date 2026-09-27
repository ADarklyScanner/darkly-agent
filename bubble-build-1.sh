#!/bin/bash
# Bubble Foam Frenzy -> Android app (Frenzy + Classic, phone-only scores, AdMob interstitial after rounds)
set -x
OUT=/out; mkdir -p $OUT
( cd $OUT && python3 -m http.server ${PORT:-8080} ) &
echo "STAGE START"
W=/work/bb; rm -rf $W; mkdir -p $W; cd $W
SDK=${ANDROID_HOME:-/opt/android-sdk-linux}
yes | $SDK/cmdline-tools/latest/bin/sdkmanager "platforms;android-36" "build-tools;36.0.0" > /dev/null 2>&1
curl -sSL https://codeload.github.com/ADarklyScanner/darkly-agent/tar.gz/refs/heads/build-inputs | tar xz --strip-components=1 --wildcards '*/bubble/*'
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
[ -s web/frenzy/index.html ] && [ -s web/classic/index.html ] || { echo "STAGE DONE_FAIL noweb"; sleep infinity; }

mkdir -p web/menu && cp bubble/menu.html web/menu/index.html && cp web/logo.png web/menu/logo.png
python3 - <<'PY'
import re
for d in ['classic','frenzy']:
    f=f'web/{d}/index.html'; s=open(f,encoding='utf-8').read()
    s=re.sub(r'<script(?:(?!</script>).)*?base44(?:(?!</script>).)*?</script>','',s,flags=re.S|re.I)
    open(f,'w',encoding='utf-8').write(s)
    print('WEB',d,'base44 left:',len(re.findall('base44',s,re.I)),'shim:', 'darkly-shim.js' in s)
PY
export DEBIAN_FRONTEND=noninteractive; python3 -c 'import PIL' 2>/dev/null || (apt-get update -qq && apt-get install -y -qq python3-pil > /dev/null)
grep -o '.\{80\}base44.\{80\}' web/classic/index.html | head -3

P=$W/app; A=$P/app/src/main; mkdir -p $A/assets $A/java/com/darkly/bubblefoam $A/res/values
cp -r web $A/assets/web
python3 - "$A/res" web/logo.png <<'PY'
import sys,os
from PIL import Image
res,src=sys.argv[1],sys.argv[2]
im=Image.open(src).convert('RGBA'); w,h=im.size; s=min(w,h); im=im.crop(((w-s)//2,(h-s)//2,(w-s)//2+s,(h-s)//2+s))
for d,px in {'mdpi':48,'hdpi':72,'xhdpi':96,'xxhdpi':144,'xxxhdpi':192}.items():
    os.makedirs(f'{res}/mipmap-{d}',exist_ok=True)
    im.resize((px,px),Image.LANCZOS).save(f'{res}/mipmap-{d}/ic_launcher.png')
im.resize((512,512),Image.LANCZOS).convert('RGB').save('/out/Bubble-Foam-icon-512.png')
print('ICONS_OK',w,h)
PY
[ -f $A/res/mipmap-xxxhdpi/ic_launcher.png ] || { echo 'STAGE DONE_FAIL icons'; sleep infinity; }
echo "$BUBBLE_P12_B64" | base64 -d > $W/release.p12

cat > $P/settings.gradle <<'EOF'
pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name = "BubbleFoam"
include ':app'
EOF
echo "plugins { id 'com.android.application' version '8.11.1' apply false }" > $P/build.gradle
printf 'org.gradle.jvmargs=-Xmx3g\nandroid.useAndroidX=true\norg.gradle.daemon=false\n' > $P/gradle.properties
write_gradle() {
cat > $P/app/build.gradle <<EOF
plugins { id 'com.android.application' }
android {
  namespace 'com.darkly.bubblefoam'
  compileSdk 36
  defaultConfig {
    applicationId 'com.darkly.bubblefoam'
    minSdk 26
    targetSdk 36
    versionCode ${BUBBLE_VERSION_CODE:-1}
    versionName '${BUBBLE_VERSION_NAME:-1.0}'
    manifestPlaceholders = [admobAppId: '$1']
    buildConfigField 'String', 'INTERSTITIAL_ID', '"$2"'
  }
  buildFeatures { buildConfig true }
  aaptOptions { ignoreAssetsPattern '!.svn:!.git:!.ds_store:!*.scc:!CVS:!thumbs.db:!picasa.ini:!*~' }
  signingConfigs { release { storeFile file('$W/release.p12'); storeType 'pkcs12'; storePassword '${BUBBLE_P12_PASS}'; keyAlias 'bubble'; keyPassword '${BUBBLE_P12_PASS}' } }
  buildTypes { release { minifyEnabled false; signingConfig signingConfigs.release } }
  compileOptions { sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }
}
dependencies {
  implementation 'com.google.android.gms:play-services-ads:24.4.0'
  implementation 'com.google.android.ump:user-messaging-platform:3.2.0'
}
EOF
}
cat > $A/AndroidManifest.xml <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET"/>
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
  <application android:theme="@style/AppTheme" android:label="Bubble Foam Frenzy"
      android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher"
      android:allowBackup="true" android:usesCleartextTraffic="false">
    <meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value="${admobAppId}"/>
    <activity android:name=".MainActivity" android:exported="true" android:configChanges="orientation|screenSize|keyboardHidden|screenLayout|smallestScreenSize">
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
      </intent-filter>
    </activity>
  </application>
</manifest>
EOF
cat > $A/res/values/styles.xml <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<resources>
  <style name="AppTheme" parent="android:style/Theme.Material.NoActionBar">
    <item name="android:statusBarColor">#ff0e0a14</item>
    <item name="android:navigationBarColor">#ff0e0a14</item>
    <item name="android:windowBackground">@android:color/black</item>
  </style>
</resources>
EOF
cat > $A/java/com/darkly/bubblefoam/MainActivity.java <<'EOF'
package com.darkly.bubblefoam;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.annotation.NonNull;
import com.google.android.gms.ads.AdError;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.FullScreenContentCallback;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;
import com.google.android.gms.ads.interstitial.InterstitialAd;
import com.google.android.gms.ads.interstitial.InterstitialAdLoadCallback;
import com.google.android.ump.ConsentInformation;
import com.google.android.ump.ConsentRequestParameters;
import com.google.android.ump.UserMessagingPlatform;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends Activity {
  static final String MENU = "https://menu.darkly/";
  static final String ROUND_WATCH =
    "(function(){if(window.__dw)return;window.__dw=1;var seen=false;setInterval(function(){"
    + "var over=false;var bs=document.querySelectorAll('button');for(var i=0;i<bs.length;i++){if(/play again/i.test(bs[i].innerText)){over=true;break;}}"
    + "if(over&&!seen){seen=true;setTimeout(function(){try{DarklyAds.roundOver()}catch(e){}},1500);}if(!over)seen=false;},1000);})();";
  private WebView web;
  private InterstitialAd interstitial;
  private long lastAd = 0;
  private final AtomicBoolean adsStarted = new AtomicBoolean(false);
  private ConsentInformation consent;

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    web = new WebView(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    web.setBackgroundColor(Color.rgb(14, 10, 20));
    web.setWebChromeClient(new WebChromeClient());
    web.setWebViewClient(new Client());
    web.addJavascriptInterface(new Bridge(), "DarklyAds");
    web.loadUrl(MENU);
    setContentView(web);
    if (Build.VERSION.SDK_INT >= 33) {
      getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, this::handleBack);
    }
    consent = UserMessagingPlatform.getConsentInformation(this);
    consent.requestConsentInfoUpdate(this, new ConsentRequestParameters.Builder().build(),
        () -> UserMessagingPlatform.loadAndShowConsentFormIfRequired(this, err -> { if (consent.canRequestAds()) startAds(); }),
        err -> { if (consent.canRequestAds()) startAds(); });
    if (consent.canRequestAds()) startAds();
  }

  private void handleBack() {
    String u = web.getUrl();
    if (u != null && !u.startsWith(MENU)) web.loadUrl(MENU); else finish();
  }
  @Override public void onBackPressed() { handleBack(); }

  private void startAds() {
    if (!adsStarted.compareAndSet(false, true)) return;
    new Thread(() -> MobileAds.initialize(this, st -> runOnUiThread(this::loadInterstitial))).start();
  }
  private void loadInterstitial() {
    InterstitialAd.load(this, BuildConfig.INTERSTITIAL_ID, new AdRequest.Builder().build(), new InterstitialAdLoadCallback() {
      @Override public void onAdLoaded(@NonNull InterstitialAd ad) { interstitial = ad; }
      @Override public void onAdFailedToLoad(@NonNull LoadAdError e) { interstitial = null; }
    });
  }

  class Bridge {
    @JavascriptInterface public void roundOver() {
      runOnUiThread(() -> {
        long now = System.currentTimeMillis();
        InterstitialAd ad = interstitial;
        if (ad == null || now - lastAd < 120000) return;
        interstitial = null; lastAd = now;
        ad.setFullScreenContentCallback(new FullScreenContentCallback() {
          @Override public void onAdDismissedFullScreenContent() { loadInterstitial(); }
          @Override public void onAdFailedToShowFullScreenContent(@NonNull AdError e) { loadInterstitial(); }
        });
        ad.show(MainActivity.this);
      });
    }
  }

  static String mime(String p) {
    if (p.endsWith(".html")) return "text/html";
    if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
    if (p.endsWith(".css")) return "text/css";
    if (p.endsWith(".png")) return "image/png";
    if (p.endsWith(".svg")) return "image/svg+xml";
    if (p.endsWith(".json")) return "application/json";
    if (p.endsWith(".webp")) return "image/webp";
    if (p.endsWith(".woff2")) return "font/woff2";
    if (p.endsWith(".mp3")) return "audio/mpeg";
    if (p.endsWith(".wav")) return "audio/wav";
    return "application/octet-stream";
  }

  class Client extends WebViewClient {
    @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
      Uri u = r.getUrl(); String h = u.getHost();
      if (h == null) return null;
      if (h.contains("base44")) return new WebResourceResponse("text/plain", "utf-8", 204, "No Content", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
      String dir = h.equals("menu.darkly") ? "menu" : h.equals("classic.darkly") ? "classic" : h.equals("frenzy.darkly") ? "frenzy" : null;
      if (dir == null) return null;
      String p = u.getPath();
      if (p == null || p.isEmpty() || p.equals("/")) p = "/index.html";
      String asset = "web/" + dir + p;
      InputStream in;
      try { in = getAssets().open(asset); }
      catch (IOException e) {
        if (p.startsWith("/api/")) return new WebResourceResponse("application/json", "utf-8", new ByteArrayInputStream("[]".getBytes()));
        try { in = getAssets().open("web/" + dir + "/index.html"); asset = "index.html"; } catch (IOException e2) { return null; }
      }
      WebResourceResponse res = new WebResourceResponse(mime(asset), "utf-8", in);
      HashMap<String, String> hd = new HashMap<>(); hd.put("Access-Control-Allow-Origin", "*"); hd.put("Cache-Control", "no-cache");
      res.setResponseHeaders(hd);
      return res;
    }
    @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
      String h = r.getUrl().getHost();
      if (h != null && h.endsWith(".darkly")) return false;
      if (h != null && h.contains("base44")) return true;
      try { startActivity(new Intent(Intent.ACTION_VIEW, r.getUrl())); } catch (Exception e) {}
      return true;
    }
    @Override public void onPageFinished(WebView v, String url) {
      if (url != null && !url.startsWith(MENU)) v.evaluateJavascript(ROUND_WATCH, null);
    }
  }
}
EOF

cd $W; curl -sSL -o g.zip https://services.gradle.org/distributions/gradle-8.14.3-bin.zip && unzip -q g.zip; G=$W/gradle-8.14.3/bin/gradle
T_APP=ca-app-pub-3940256099942544~3347511713; T_IN=ca-app-pub-3940256099942544/1033173712
cd $P && write_gradle "$T_APP" "$T_IN" && $G --no-daemon -q assembleRelease; RC=$?
echo "ASSEMBLE_EXIT=$RC"
if [ $RC -eq 0 ]; then
  cp app/build/outputs/apk/release/app-release.apk $OUT/TEST-INSTALL-Bubble-Foam-Frenzy.apk
  $SDK/build-tools/36.0.0/aapt2 dump badging $OUT/TEST-INSTALL-Bubble-Foam-Frenzy.apk | head -4
  unzip -l $OUT/TEST-INSTALL-Bubble-Foam-Frenzy.apk | grep -c 'assets/web/'
  if [ -n "$BUBBLE_ADMOB_APP_ID" ]; then
    write_gradle "$BUBBLE_ADMOB_APP_ID" "$BUBBLE_ADMOB_INTERSTITIAL_ID" && $G --no-daemon -q bundleRelease && cp app/build/outputs/bundle/release/app-release.aab $OUT/Bubble-Foam-Frenzy-PLAY.aab && echo "PLAY_AAB_OK"
  fi
  ls -la $OUT
  echo "STAGE DONE_OK"
else
  echo "STAGE DONE_FAIL"
fi
sleep infinity
