package com.darkly.robot;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * The robot's whole screen. It is also the phone's home screen once chosen as
 * the default home app, so it boots into this and Home always comes back here.
 */
public class MainActivity extends Activity implements DeviceLink.Host {
    private static final int GREEN = Color.rgb(104, 229, 156);
    private static final int DIM = Color.rgb(120, 120, 130);
    private static final int AMBER = Color.rgb(240, 195, 90);
    private static final int BG = Color.rgb(10, 10, 12);
    private static final int PANEL = Color.rgb(24, 24, 28);

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private final Random rng = new Random();

    private Brain brain;
    private Body body;
    private SensorHub senses;
    private DeviceLink link;
    private LocalBrain localBrain;
    private boolean wasOnline = false;
    private boolean recognizerOffline = false;
    private ConnectivityManager.NetworkCallback netCallback;

    private TextView face, status, logView;
    private ScrollView logScroll;
    private EditText input;
    private Button listenBtn;
    private final ArrayList<String> logLines = new ArrayList<>();

    private TextToSpeech tts;
    private boolean ttsReady = false;
    private SpeechRecognizer recognizer;
    private boolean listening = false, speaking = false, thinking = false;
    private volatile Brain.Source lastSource = null;
    private long lastComplaint = 0;
    private boolean pushingSensors = false;

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            refreshStatus();
            maybeComplain();
            ui.postDelayed(this, 3000);
        }
    };

    private final BroadcastReceiver usbReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            UsbDevice d = i.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            String what = d == null ? "a USB device" : body.describe(d);
            if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(i.getAction())) {
                log("Body part connected: " + what);
                say("Oh. Something's plugged into me. " + (d != null && d.getProductName() != null ? d.getProductName() : "Unknown part") + ". No driver for it yet, but I noticed.");
            } else {
                log("Body part disconnected: " + what);
            }
            refreshStatus();
        }
    };

    // ---------------------------------------------------------------- lifecycle

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        brain = new Brain(this);
        body = new Body(this);
        senses = new SensorHub(this);
        link = new DeviceLink(this, this);
        localBrain = new LocalBrain(this);
        buildUi();

        tts = new TextToSpeech(this, st -> {
            ttsReady = st == TextToSpeech.SUCCESS;
            if (ttsReady) {
                tts.setLanguage(Locale.US);
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { ui.post(() -> { speaking = true; setFace(); }); }
                    @Override public void onDone(String id) { ui.post(() -> { speaking = false; setFace(); resumeListening(); }); }
                    @Override public void onError(String id) { ui.post(() -> { speaking = false; setFace(); resumeListening(); }); }
                });
                ui.postDelayed(this::greet, 600);
            }
        });

        askPermissions();
        senses.start();
        link.start();
        localBrain.start();
        startSensorPush();
        watchNetwork();

        IntentFilter f = new IntentFilter();
        f.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        f.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(usbReceiver, f, Context.RECEIVER_EXPORTED);
        else registerReceiver(usbReceiver, f);

        wasOnline = Brain.online(this);
        log("Robot awake. " + (wasOnline ? "Internet: yes." : "Internet: none, running on my own brain.") + " " + body.summary());
        if (!Prefs.onboarded(this)) ui.postDelayed(this::firstRun, 800);
        ui.post(tick);
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemBars();
        if (Prefs.alwaysListen(this)) resumeListening();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        try { unregisterReceiver(usbReceiver); } catch (Exception ignored) {}
        senses.stop();
        link.stop();
        localBrain.stop();
        pushingSensors = false;
        if (netCallback != null) try {
            ((ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE)).unregisterNetworkCallback(netCallback);
        } catch (Exception ignored) {}
        if (recognizer != null) recognizer.destroy();
        if (tts != null) tts.shutdown();
        work.shutdownNow();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    /** It's the home screen: Back has nowhere to go. */
    @Override
    public void onBackPressed() { /* stay */ }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    private void askPermissions() {
        ArrayList<String> need = new ArrayList<>();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 29 && checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) != PackageManager.PERMISSION_GRANTED)
            need.add(Manifest.permission.ACTIVITY_RECOGNITION);
        if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), 1);
    }

    // ---------------------------------------------------------------- UI

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        root.setPadding(dp(14), dp(28), dp(14), dp(14));

        face = text(56, GREEN);
        face.setGravity(Gravity.CENTER);
        face.setOnLongClickListener(v -> { openSetup(); return true; });
        root.addView(face, new LinearLayout.LayoutParams(-1, -2));

        status = text(13, DIM);
        status.setPadding(0, dp(6), 0, dp(10));
        root.addView(status, new LinearLayout.LayoutParams(-1, -2));

        logScroll = new ScrollView(this);
        logScroll.setBackgroundColor(PANEL);
        logView = text(15, Color.rgb(225, 225, 230));
        logView.setPadding(dp(12), dp(10), dp(12), dp(10));
        logView.setTextIsSelectable(true);
        logScroll.addView(logView);
        root.addView(logScroll, new LinearLayout.LayoutParams(-1, 0, 1f));

        LinearLayout row = new LinearLayout(this);
        row.setPadding(0, dp(10), 0, 0);
        input = new EditText(this);
        input.setHint("Talk to it…");
        input.setHintTextColor(DIM);
        input.setTextColor(Color.WHITE);
        input.setBackgroundColor(PANEL);
        input.setPadding(dp(12), dp(10), dp(12), dp(10));
        input.setImeOptions(EditorInfo.IME_ACTION_SEND);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        input.setOnEditorActionListener((v, id, ev) -> {
            if (id == EditorInfo.IME_ACTION_SEND || (ev != null && ev.getKeyCode() == KeyEvent.KEYCODE_ENTER)) { sendTyped(); return true; }
            return false;
        });
        row.addView(input, new LinearLayout.LayoutParams(0, -2, 1f));
        row.addView(button("Send", v -> sendTyped()));
        root.addView(row);

        LinearLayout bar = new LinearLayout(this);
        bar.setPadding(0, dp(8), 0, 0);
        bar.addView(button("Talk", v -> listenOnce()), weight());
        listenBtn = button(Prefs.alwaysListen(this) ? "Ears: on" : "Ears: off", v -> toggleEars());
        bar.addView(listenBtn, weight());
        bar.addView(button("Files", v -> startActivity(new Intent(this, FilesActivity.class))), weight());
        bar.addView(button("Setup", v -> openSetup()), weight());
        root.addView(bar);

        setContentView(root);
        setFace();
    }

    private LinearLayout.LayoutParams weight() { return new LinearLayout.LayoutParams(0, -2, 1f); }

    private TextView text(int sp, int color) {
        TextView t = new TextView(this);
        t.setTextSize(sp);
        t.setTextColor(color);
        t.setTypeface(Typeface.MONOSPACE);
        return t;
    }

    private Button button(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(GREEN);
        b.setBackgroundColor(Color.rgb(30, 44, 36));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
        lp.setMargins(dp(4), 0, 0, 0);
        b.setLayoutParams(lp);
        b.setOnClickListener(l);
        return b;
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private void setFace() {
        if (face == null) return;
        String f;
        int color = GREEN;
        if (thinking) { f = "[ ◔  ◔ ]"; color = AMBER; }
        else if (speaking) { f = "[ ◉ ▭ ◉ ]"; }
        else if (listening) { f = "[ ◎  ◎ ]"; }
        else if (lastSource == Brain.Source.NONE) { f = "[ ×  × ]"; color = Color.rgb(255, 120, 120); }
        else { f = "[ ◉  ◉ ]"; }
        face.setText(f);
        face.setTextColor(color);
    }

    private void refreshStatus() {
        boolean online = Brain.online(this);
        String brainLine;
        if (online && Prefs.configured(this)) brainLine = "Brain: Darkly engine" + (lastSource == Brain.Source.LOCAL ? " (last reply came from offline brain)" : "");
        else if (online) brainLine = "Brain: offline brain (add the passcode in Setup to use the engine)";
        else brainLine = "Brain: offline brain (no internet)";
        brainLine += "\n" + localBrain.describe();
        String linkLine = !online ? "Link: waiting for internet" : !Prefs.configured(this) ? "Link: off"
            : link.isRegistered() ? "Link: connected" : "Link: trying" + (link.lastError().isEmpty() ? "" : " (" + link.lastError() + ")");
        String ears = listening ? "listening" : Prefs.alwaysListen(this) ? "ears on" : "ears off";
        status.setText(brainLine + "\n" + linkLine + " · " + ears + "\n" + body.summary() + "\n" + senses.shortLine());
    }

    @Override
    public void log(String line) {
        ui.post(() -> {
            String stamp = new SimpleDateFormat("HH:mm", Locale.US).format(new Date());
            logLines.add(stamp + "  " + line);
            while (logLines.size() > 200) logLines.remove(0);
            logView.setText(String.join("\n\n", logLines));
            logScroll.post(() -> logScroll.fullScroll(View.FOCUS_DOWN));
        });
    }

    // ---------------------------------------------------------------- talking

    private void greet() {
        if (body.parts().isEmpty()) say("I'm up. " + Body.COMPLAINTS[0]);
        else say("I'm up. Something's plugged into me. Finally.");
    }

    private void maybeComplain() {
        long now = System.currentTimeMillis();
        if (!body.parts().isEmpty() || thinking || speaking || listening) return;
        if (now - lastComplaint < 20 * 60 * 1000) return;
        if (lastComplaint == 0) { lastComplaint = now; return; }
        lastComplaint = now;
        log("🤖 " + Body.COMPLAINTS[rng.nextInt(Body.COMPLAINTS.length)]);
    }

    private void sendTyped() {
        String t = input.getText().toString().trim();
        if (t.isEmpty()) return;
        input.setText("");
        handle(t);
    }

    private void handle(String said) {
        if (thinking) { log("(still thinking about the last one)"); return; }
        log("You: " + said);
        thinking = true;
        setFace();
        pauseListening();
        final String report = body.summary() + " " + senses.shortLine() + ".";
        work.execute(() -> {
            Brain.Reply r = brain.think(said, report);
            ui.post(() -> {
                thinking = false;
                lastSource = r.source;
                String tag = r.source == Brain.Source.ENGINE ? "" : r.source == Brain.Source.LOCAL ? " [on-phone brain]" : " [no brain]";
                log("Robot" + tag + ": " + r.text);
                setFace();
                refreshStatus();
                if (Prefs.speakReplies(this)) say(r.text); else resumeListening();
            });
        });
    }

    @Override
    public void say(String text) {
        ui.post(() -> {
            if (!ttsReady) { resumeListening(); return; }
            pauseListening();
            String clean = text.replaceAll("[*_`#>]", "").replaceAll("\\s+", " ").trim();
            if (clean.length() > 3500) clean = clean.substring(0, 3500);
            Bundle p = new Bundle();
            tts.speak(clean, TextToSpeech.QUEUE_ADD, p, "u" + System.nanoTime());
        });
    }

    // ---------------------------------------------------------------- hearing

    private void ensureRecognizer() {
        boolean wantOffline = !Brain.online(this);
        if (recognizer != null && recognizerOffline == wantOffline) return;
        if (recognizer != null) { recognizer.destroy(); recognizer = null; }
        recognizerOffline = wantOffline;
        if (wantOffline && Build.VERSION.SDK_INT >= 33 && SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) {
            recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this);
        } else {
            if (!SpeechRecognizer.isRecognitionAvailable(this)) { log("This phone has no speech recognizer available."); return; }
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
        }
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle b) { listening = true; setFace(); refreshStatus(); }
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float v) {}
            @Override public void onBufferReceived(byte[] b) {}
            @Override public void onEndOfSpeech() {}
            @Override public void onError(int error) {
                listening = false; setFace();
                if (error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE)
                    log("Can't hear offline yet: the phone needs its offline English speech pack (Settings > Samsung/Google voice input > offline languages). Typing still works.");
                // Silence and "didn't catch that" are normal; just go back to listening.
                if (Prefs.alwaysListen(MainActivity.this)) ui.postDelayed(MainActivity.this::resumeListening, 1200);
            }
            @Override public void onResults(Bundle b) {
                listening = false; setFace();
                ArrayList<String> heard = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                if (heard != null && !heard.isEmpty() && !heard.get(0).trim().isEmpty()) handle(heard.get(0).trim());
                else resumeListening();
            }
            @Override public void onPartialResults(Bundle b) {}
            @Override public void onEvent(int t, Bundle b) {}
        });
    }

    private void listenOnce() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { askPermissions(); return; }
        if (speaking) tts.stop();
        ensureRecognizer();
        if (recognizer == null || listening || thinking) return;
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US");
        i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, recognizerOffline);
        listening = true;
        setFace();
        recognizer.startListening(i);
    }

    private void resumeListening() {
        if (Prefs.alwaysListen(this) && !speaking && !thinking && !listening) listenOnce();
    }

    private void pauseListening() {
        if (recognizer != null && listening) { recognizer.cancel(); listening = false; setFace(); }
    }

    private void toggleEars() {
        boolean on = !Prefs.alwaysListen(this);
        Prefs.setListen(this, on);
        listenBtn.setText(on ? "Ears: on" : "Ears: off");
        if (on) resumeListening(); else pauseListening();
        refreshStatus();
    }

    // ---------------------------------------------------------------- engine link

    @Override
    public void confirm(String title, String message, Consumer<Boolean> answer) {
        ui.post(() -> {
            say("The engine is asking for something. Check the screen.");
            new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(message)
                .setCancelable(false)
                .setPositiveButton("Allow", (d, w) -> answer.accept(true))
                .setNegativeButton("Deny", (d, w) -> answer.accept(false))
                .show();
        });
    }

    @Override
    public JSONObject status() throws Exception {
        return new JSONObject()
            .put("brain", lastSource == null ? "engine (not asked yet)" : lastSource.name().toLowerCase(Locale.US))
            .put("listening", Prefs.alwaysListen(this))
            .put("body", body.toJson())
            .put("sensors", senses.snapshot())
            .put("allFilesAccess", Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager())
            .put("app", "Darkly Robot " + appVersion());
    }

    @Override
    public JSONObject body() throws Exception { return body.toJson(); }

    private String appVersion() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (Exception e) { return "?"; }
    }

    private void watchNetwork() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (cm == null) return;
        netCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) { ui.postDelayed(MainActivity.this::networkChanged, 2500); }
            @Override public void onLost(Network n) { ui.postDelayed(MainActivity.this::networkChanged, 1000); }
        };
        try { cm.registerDefaultNetworkCallback(netCallback); } catch (Exception ignored) {}
    }

    private void networkChanged() {
        boolean now = Brain.online(this);
        if (now == wasOnline) { refreshStatus(); return; }
        wasOnline = now;
        if (now) log(Prefs.configured(this) ? "Internet's back. Thinking with the engine again." : "Internet's back. Add the passcode in Setup and I'll use the engine.");
        else log("Lost the internet. Running on my own brain.");
        refreshStatus();
    }

    /** First launch: the one-time steps that make it boot into the robot. */
    private void firstRun() {
        new AlertDialog.Builder(this)
            .setTitle("One-time setup")
            .setMessage("1. Tap \"Make it home\" and pick Darkly Robot, set as default. After that the phone boots straight into me.\n\n" +
                "2. Optional: tap Setup later and add your Darkly passcode. Without it I still work, on my own offline brain.\n\n" +
                "My offline brain unpacks itself the first time (a few minutes). Leave me on the charger.")
            .setCancelable(false)
            .setPositiveButton("Make it home", (d, w) -> { Prefs.setOnboarded(this); openHomeSettings(); })
            .setNeutralButton("Later", (d, w) -> { Prefs.setOnboarded(this); hideSystemBars(); })
            .show();
    }

    private void startSensorPush() {
        pushingSensors = true;
        Thread t = new Thread(() -> {
            try { Thread.sleep(10000); } catch (InterruptedException ignored) {}
            while (pushingSensors) {
                try {
                    if (Prefs.configured(this) && Brain.online(this)) {
                        Map<String, String> h = new HashMap<>();
                        h.put("X-Agent-Passcode", Prefs.passcode(this));
                        Http.request("POST", Prefs.server(this) + "/sensor-reading",
                            new JSONObject().put("readings", senses.readings()), h, 20000);
                    }
                } catch (Exception ignored) { /* engine offline; try again next round */ }
                try { Thread.sleep(60000); } catch (InterruptedException ignored) {}
            }
        }, "sensor-push");
        t.setDaemon(true);
        t.start();
    }

    // ---------------------------------------------------------------- setup

    private void openSetup() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(18), dp(8), dp(18), dp(8));

        EditText server = field(box, "Darkly Agent address", Prefs.server(this), false);
        EditText pass = field(box, "Passcode (same one you use on the console)", Prefs.passcode(this), true);
        EditText local = field(box, "On-phone model address (llama-server in Termux)", Prefs.localServer(this), false);
        EditText prompt = field(box, "Offline brain prompt", Prefs.prompt(this), false);
        prompt.setMinLines(4);
        prompt.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);

        CheckBox speak = new CheckBox(this);
        speak.setText("Speak replies out loud");
        speak.setChecked(Prefs.speakReplies(this));
        box.addView(speak);
        CheckBox ears = new CheckBox(this);
        ears.setText("Ears always on (listens again after each reply)");
        ears.setChecked(Prefs.alwaysListen(this));
        box.addView(ears);

        Button files = new Button(this);
        files.setAllCaps(false);
        files.setText(Build.VERSION.SDK_INT >= 30 && !Environment.isExternalStorageManager()
            ? "Give it access to all files" : "All files access: granted");
        files.setOnClickListener(v -> openAllFilesAccess());
        box.addView(files);

        Button home = new Button(this);
        home.setAllCaps(false);
        home.setText("Make it the phone's home screen / switch back");
        home.setOnClickListener(v -> openHomeSettings());
        box.addView(home);

        ScrollView sv = new ScrollView(this);
        sv.addView(box);

        new AlertDialog.Builder(this)
            .setTitle("Robot setup")
            .setView(sv)
            .setPositiveButton("Save", (d, w) -> {
                Prefs.save(this, server.getText().toString(), pass.getText().toString(), local.getText().toString(),
                    prompt.getText().toString(), speak.isChecked(), ears.isChecked());
                listenBtn.setText(ears.isChecked() ? "Ears: on" : "Ears: off");
                log("Setup saved.");
                refreshStatus();
                hideSystemBars();
                if (ears.isChecked()) resumeListening(); else pauseListening();
            })
            .setNegativeButton("Cancel", (d, w) -> hideSystemBars())
            .show();
    }

    private EditText field(LinearLayout box, String label, String value, boolean secret) {
        TextView l = new TextView(this);
        l.setText(label);
        l.setPadding(0, dp(10), 0, 0);
        box.addView(l);
        EditText e = new EditText(this);
        e.setText(value);
        e.setInputType(secret ? (InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD) : InputType.TYPE_CLASS_TEXT);
        box.addView(e, new ViewGroup.LayoutParams(-1, -2));
        return e;
    }

    private void openAllFilesAccess() {
        if (Build.VERSION.SDK_INT < 30) { Toast.makeText(this, "Not needed on this Android version", Toast.LENGTH_SHORT).show(); return; }
        try {
            startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getPackageName())));
        } catch (Exception e) {
            startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
        }
    }

    private void openHomeSettings() {
        try { startActivity(new Intent(Settings.ACTION_HOME_SETTINGS)); }
        catch (Exception e) { startActivity(new Intent(Settings.ACTION_SETTINGS)); }
    }
}
