#!/bin/bash
# RNG Lucky - Google Play build with AdMob (runs on Railway apk-builder)
set -x
OUT=/out; mkdir -p $OUT
( cd $OUT && (command -v python3 >/dev/null && python3 -m http.server ${PORT:-8080} || jwebserver -b 0.0.0.0 -p ${PORT:-8080} -d $OUT) ) &
echo "STAGE START"
W=/work; rm -rf $W; mkdir -p $W; cd $W
export GRADLE_OPTS="-Xmx3g"
SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/android-sdk-linux}}
echo "SDK=$SDK"; java -version 2>&1
yes | $SDK/cmdline-tools/latest/bin/sdkmanager "platforms;android-36" "build-tools;36.0.0" > /dev/null 2>&1; echo "SDKMGR=$?"

# 1) game files from the v146 APK (shared from Drive)
curl -sSL -o src.tgz "https://codeload.github.com/ADarklyScanner/darkly-agent/tar.gz/refs/heads/build-inputs" && mkdir -p srcx && tar xzf src.tgz -C srcx --strip-components=2 || { echo "STAGE DONE_FAIL src"; sleep infinity; }
mkdir -p srcapk/assets && cp srcx/index.html srcapk/assets/ && cp -r srcx/res srcapk/res && ls -la srcapk/assets srcapk/res

P=$W/app; mkdir -p $P/app/src/main/assets $P/app/src/main/java/com/darkly/rnglucky $P/app/src/main/res/values
cp srcapk/assets/index.html $P/app/src/main/assets/index.html
for d in mdpi hdpi xhdpi xxhdpi xxxhdpi; do mkdir -p $P/app/src/main/res/mipmap-$d; cp srcapk/res/mipmap-$d-v4/ic_launcher.png $P/app/src/main/res/mipmap-$d/ic_launcher.png; cp srcapk/res/mipmap-$d-v4/ic_launcher.png $P/app/src/main/res/mipmap-$d/ic_launcher_round.png; done

# 2) hook ads into the game (rewarded = repair button, interstitial = every 35 big pushes, max 1 per 3 min)
python3 - "$P/app/src/main/assets/index.html" <<'PY' || { echo "STAGE DONE_FAIL patch"; sleep infinity; }
import sys
f=sys.argv[1]; s=open(f,encoding='utf-8').read()
a="yes.onclick=()=>repair(repairTarget);"
b="big.onclick=()=>press('big');"
assert s.count(a)==1 and s.count(b)==1
s=s.replace(a,"yes.onclick=()=>{const t=repairTarget;if(window.DarklyAds){window.__darklyReward=ok=>{if(ok)repair(t);else hideRepair()};DarklyAds.showRewarded()}else repair(t)};")
s=s.replace(b,"big.onclick=()=>{press('big');window.__dp=(window.__dp||0)+1;if(window.__dp%35===0&&window.DarklyAds)setTimeout(()=>DarklyAds.maybeInterstitial(),1600)};")
open(f,'w',encoding='utf-8').write(s); print("PATCH_OK")
PY

# 3) signing key
echo "$P12_B64" | base64 -d > $W/release.p12

cat > $P/settings.gradle <<'EOF'
pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name = "RngLucky"
include ':app'
EOF
cat > $P/build.gradle <<'EOF'
plugins { id 'com.android.application' version '8.11.1' apply false }
EOF
cat > $P/gradle.properties <<'EOF'
org.gradle.jvmargs=-Xmx3g
android.useAndroidX=true
org.gradle.daemon=false
EOF
cat > $P/app/build.gradle <<EOF
plugins { id 'com.android.application' }
android {
  namespace 'com.darkly.rnglucky'
  compileSdk 36
  defaultConfig {
    applicationId 'com.darkly.rnglucky'
    minSdk 26
    targetSdk 36
    versionCode ${VERSION_CODE:-1}
    versionName '${VERSION_NAME:-1.0}'
    manifestPlaceholders = [admobAppId: '${ADMOB_APP_ID}']
    buildConfigField 'String', 'REWARDED_ID', '"${ADMOB_REWARDED_ID}"'
    buildConfigField 'String', 'INTERSTITIAL_ID', '"${ADMOB_INTERSTITIAL_ID}"'
  }
  buildFeatures { buildConfig true }
  signingConfigs { release { storeFile file('$W/release.p12'); storeType 'pkcs12'; storePassword '${P12_PASS}'; keyAlias 'rng 1-100'; keyPassword '${P12_PASS}' } }
  buildTypes { release { minifyEnabled false; signingConfig signingConfigs.release } }
  compileOptions { sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }
}
dependencies {
  implementation 'com.google.android.gms:play-services-ads:24.4.0'
  implementation 'com.google.android.ump:user-messaging-platform:3.2.0'
}
EOF
cat > $P/app/src/main/AndroidManifest.xml <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET"/>
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
  <uses-permission android:name="android.permission.VIBRATE"/>
  <application android:theme="@style/AppTheme" android:label="1-100 RNG Lucky #"
      android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round"
      android:allowBackup="true" android:usesCleartextTraffic="false">
    <meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value="${admobAppId}"/>
    <activity android:name=".MainActivity" android:exported="true" android:configChanges="orientation|screenSize|keyboardHidden">
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
      </intent-filter>
    </activity>
  </application>
</manifest>
EOF
cat > $P/app/src/main/res/values/styles.xml <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<resources>
  <style name="AppTheme" parent="android:style/Theme.Material.Light.NoActionBar">
    <item name="android:fontFamily">sans</item>
    <item name="android:colorAccent">#ff2563eb</item>
    <item name="android:statusBarColor">#cc1c0c2b</item>
    <item name="android:navigationBarColor">#cc1c0c2b</item>
    <item name="android:windowLightStatusBar">false</item>
    <item name="android:windowLightNavigationBar">false</item>
    <item name="android:windowBackground">@android:color/black</item>
  </style>
</resources>
EOF
cat > $P/app/src/main/java/com/darkly/rnglucky/MainActivity.java <<'EOF'
package com.darkly.rnglucky;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
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
import com.google.android.gms.ads.rewarded.RewardedAd;
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback;
import com.google.android.ump.ConsentInformation;
import com.google.android.ump.ConsentRequestParameters;
import com.google.android.ump.UserMessagingPlatform;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends Activity {
  private WebView web;
  private RewardedAd rewarded;
  private InterstitialAd interstitial;
  private long lastInterstitial = 0;
  private final AtomicBoolean adsStarted = new AtomicBoolean(false);
  private ConsentInformation consent;

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    getWindow().setStatusBarColor(Color.argb(204, 28, 12, 43));
    getWindow().setNavigationBarColor(Color.argb(204, 28, 12, 43));
    web = new WebView(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setAllowFileAccess(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    web.setBackgroundColor(Color.BLACK);
    web.setWebViewClient(new WebViewClient());
    web.setWebChromeClient(new WebChromeClient());
    web.addJavascriptInterface(new Bridge(), "DarklyAds");
    web.loadUrl("file:///android_asset/index.html");
    setContentView(web);

    consent = UserMessagingPlatform.getConsentInformation(this);
    consent.requestConsentInfoUpdate(this, new ConsentRequestParameters.Builder().build(),
        () -> UserMessagingPlatform.loadAndShowConsentFormIfRequired(this, err -> { if (consent.canRequestAds()) startAds(); }),
        err -> { if (consent.canRequestAds()) startAds(); });
    if (consent.canRequestAds()) startAds();
  }

  private void startAds() {
    if (!adsStarted.compareAndSet(false, true)) return;
    new Thread(() -> MobileAds.initialize(this, st -> runOnUiThread(() -> { loadRewarded(); loadInterstitial(); }))).start();
  }

  private void loadRewarded() {
    RewardedAd.load(this, BuildConfig.REWARDED_ID, new AdRequest.Builder().build(), new RewardedAdLoadCallback() {
      @Override public void onAdLoaded(@NonNull RewardedAd ad) { rewarded = ad; }
      @Override public void onAdFailedToLoad(@NonNull LoadAdError e) { rewarded = null; }
    });
  }

  private void loadInterstitial() {
    InterstitialAd.load(this, BuildConfig.INTERSTITIAL_ID, new AdRequest.Builder().build(), new InterstitialAdLoadCallback() {
      @Override public void onAdLoaded(@NonNull InterstitialAd ad) { interstitial = ad; }
      @Override public void onAdFailedToLoad(@NonNull LoadAdError e) { interstitial = null; }
    });
  }

  private void tellGame(boolean ok) {
    web.evaluateJavascript("window.__darklyReward&&window.__darklyReward(" + ok + ")", null);
  }

  class Bridge {
    @JavascriptInterface public void showRewarded() {
      runOnUiThread(() -> {
        RewardedAd ad = rewarded;
        if (ad == null) { tellGame(true); if (adsStarted.get()) loadRewarded(); return; }
        rewarded = null;
        final boolean[] earned = {false};
        ad.setFullScreenContentCallback(new FullScreenContentCallback() {
          @Override public void onAdDismissedFullScreenContent() { tellGame(earned[0]); loadRewarded(); }
          @Override public void onAdFailedToShowFullScreenContent(@NonNull AdError e) { tellGame(true); loadRewarded(); }
        });
        ad.show(MainActivity.this, item -> earned[0] = true);
      });
    }
    @JavascriptInterface public void maybeInterstitial() {
      runOnUiThread(() -> {
        long now = System.currentTimeMillis();
        InterstitialAd ad = interstitial;
        if (ad == null || now - lastInterstitial < 180000) return;
        interstitial = null; lastInterstitial = now;
        ad.setFullScreenContentCallback(new FullScreenContentCallback() {
          @Override public void onAdDismissedFullScreenContent() { loadInterstitial(); }
          @Override public void onAdFailedToShowFullScreenContent(@NonNull AdError e) { loadInterstitial(); }
        });
        ad.show(MainActivity.this);
      });
    }
  }

  @Override public void onBackPressed() {
    if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
  }
}
EOF

# 4) gradle
cd $W; curl -sSL -o g.zip https://services.gradle.org/distributions/gradle-8.14.3-bin.zip && unzip -q g.zip; G=$W/gradle-8.14.3/bin/gradle
cd $P && $G --no-daemon -q bundleRelease assembleRelease; RC=$?
echo "ASSEMBLE_EXIT=$RC"
if [ $RC -eq 0 ]; then
  cp app/build/outputs/bundle/release/app-release.aab $OUT/1-100-RNG-Lucky-ads.aab
  cp app/build/outputs/apk/release/app-release.apk $OUT/TEST-INSTALL-RNG-Lucky-ads.apk
  AAPT=$(ls -d $SDK/build-tools/*/ | tail -1)aapt2
  $AAPT dump badging $OUT/TEST-INSTALL-RNG-Lucky-ads.apk | head -6
  ls -la $OUT; sha256sum $OUT/*
  echo "STAGE DONE_OK"
else
  echo "STAGE DONE_FAIL"
fi
sleep infinity
