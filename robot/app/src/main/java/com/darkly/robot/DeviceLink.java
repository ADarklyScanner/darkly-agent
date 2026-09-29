package com.darkly.robot;

import android.content.Context;
import android.os.Environment;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The robot as a device of Darkly Agent. It declares a short, named list of
 * things the engine may ask for (server side: device.js), polls for requests,
 * and runs them. Anything that changes something, or reads a private file,
 * is shown on screen and needs a tap to approve. That approval lives here on
 * the phone on purpose, so the server can never skip it.
 */
public final class DeviceLink {
    public interface Host {
        void log(String line);
        /** Ask the owner on screen; must eventually call answer.run(true/false). */
        void confirm(String title, String message, java.util.function.Consumer<Boolean> answer);
        void say(String text);
        JSONObject status() throws Exception;
        JSONObject body() throws Exception;
    }

    private static final File ROOT = Environment.getExternalStorageDirectory();

    private final Context ctx;
    private final Host host;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile boolean registered = false;
    private volatile String lastError = "";

    public DeviceLink(Context c, Host host) { this.ctx = c.getApplicationContext(); this.host = host; }

    public boolean isRegistered() { return registered; }
    public String lastError() { return lastError; }

    public void start() {
        if (!running.compareAndSet(false, true)) return;
        Thread t = new Thread(this::loop, "device-link");
        t.setDaemon(true);
        t.start();
    }

    public void stop() { running.set(false); }

    private Map<String, String> headers() {
        Map<String, String> h = new HashMap<>();
        h.put("X-Agent-Passcode", Prefs.passcode(ctx));
        return h;
    }

    private void loop() {
        while (running.get()) {
            try {
                if (!Prefs.configured(ctx) || !Brain.online(ctx)) { registered = false; sleep(5000); continue; }
                if (!registered) register();
                if (registered) poll();
                lastError = "";
            } catch (Exception e) {
                lastError = e.getClass().getSimpleName() + ": " + e.getMessage();
                registered = false;
                sleep(15000);
            }
            sleep(5000);
        }
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }

    private void register() throws Exception {
        JSONArray actions = new JSONArray()
            .put(action("robot.status", "Read the robot's status: battery, sensors, brain mode and what body parts are attached.", "read", new JSONObject(), false))
            .put(action("robot.body", "List what is plugged into the robot's USB port (arms, tracks, controllers).", "read", new JSONObject(), false))
            .put(action("files.list", "List the files in a folder on the robot phone's storage.", "read",
                new JSONObject().put("path", "Folder path on the phone, e.g. /storage/emulated/0/Agent Darkly. Blank means the top of storage."), false))
            .put(action("files.read", "Read a text file on the robot phone (the owner approves each read on screen).", "read",
                new JSONObject().put("path", "Full path of a text file under /storage/emulated/0."), true))
            .put(action("robot.say", "Say something out loud through the robot's speaker.", "write",
                new JSONObject().put("text", "What to say, in plain words."), false));
        JSONObject body = new JSONObject()
            .put("deviceId", Prefs.deviceId(ctx))
            .put("name", "Darkly Robot (Galaxy S22)")
            .put("actions", actions);
        Http.Result r = Http.request("POST", Prefs.server(ctx) + "/device/register", body, headers(), 20000);
        if (r.status == 401) throw new Exception("passcode rejected");
        if (!r.ok()) throw new Exception("register failed: " + r.json().optString("error", "status " + r.status));
        registered = true;
        host.log("Linked to the engine as a device (" + actions.length() + " actions).");
    }

    private static JSONObject action(String id, String desc, String effect, JSONObject params, boolean alwaysConfirm) throws Exception {
        return new JSONObject().put("id", id).put("description", desc).put("effect", effect)
            .put("params", params).put("alwaysConfirm", alwaysConfirm);
    }

    private void poll() throws Exception {
        String url = Prefs.server(ctx) + "/device/commands?deviceId=" + java.net.URLEncoder.encode(Prefs.deviceId(ctx), "UTF-8") + "&max=5";
        Http.Result r = Http.request("GET", url, null, headers(), 20000);
        JSONObject j = r.json();
        if (!r.ok() || !j.optBoolean("ok", false)) {
            // Another device registered, or the server restarted without our manifest.
            registered = false;
            return;
        }
        JSONArray cmds = j.optJSONArray("commands");
        if (cmds == null) return;
        for (int i = 0; i < cmds.length(); i++) run(cmds.getJSONObject(i));
    }

    private void run(JSONObject cmd) throws Exception {
        String id = cmd.getString("id");
        String action = cmd.getString("actionId");
        JSONObject params = cmd.optJSONObject("params");
        if (params == null) params = new JSONObject();
        JSONObject report = new JSONObject().put("commandId", id);

        if (cmd.optBoolean("requiresConfirmation", false)) {
            String why = cmd.optString("reason", "");
            String msg = "The engine wants: " + action + "\n" + params.toString(2) +
                (why.isEmpty() || "null".equals(why) ? "" : "\n\nReason: " + why) +
                (cmd.optBoolean("requestedAfterReadingExternalContent", false)
                    ? "\n\n⚠ This was requested right after the engine read outside content (a web page or similar)." : "");
            if (!ask("Allow this?", msg)) {
                host.log("Declined: " + action);
                post(report.put("ok", false).put("declined", true));
                return;
            }
        }

        try {
            JSONObject result = execute(action, params);
            host.log("Ran for the engine: " + action);
            post(report.put("ok", true).put("result", result));
        } catch (Exception e) {
            host.log("Failed for the engine: " + action + " (" + e.getMessage() + ")");
            post(report.put("ok", false).put("error", String.valueOf(e.getMessage())));
        }
    }

    private boolean ask(String title, String message) {
        CountDownLatch done = new CountDownLatch(1);
        AtomicBoolean yes = new AtomicBoolean(false);
        host.confirm(title, message, ok -> { yes.set(Boolean.TRUE.equals(ok)); done.countDown(); });
        try { done.await(5, TimeUnit.MINUTES); } catch (InterruptedException ignored) {}
        return yes.get();
    }

    private void post(JSONObject report) {
        try { Http.request("POST", Prefs.server(ctx) + "/device/result", report, headers(), 20000); }
        catch (Exception e) { host.log("Could not report a result back: " + e.getMessage()); }
    }

    private JSONObject execute(String action, JSONObject params) throws Exception {
        switch (action) {
            case "robot.status": return host.status();
            case "robot.body": return host.body();
            case "robot.say": {
                String text = params.optString("text", "").trim();
                if (text.isEmpty()) throw new Exception("nothing to say");
                host.say(text);
                return new JSONObject().put("said", text);
            }
            case "files.list": {
                File dir = safe(params.optString("path", ""));
                if (!dir.isDirectory()) throw new Exception("not a folder: " + dir);
                File[] kids = dir.listFiles();
                if (kids == null) throw new Exception("cannot read that folder (give the robot All files access)");
                Arrays.sort(kids, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
                JSONArray arr = new JSONArray();
                for (int i = 0; i < kids.length && i < 300; i++) {
                    arr.put(new JSONObject().put("name", kids[i].getName()).put("folder", kids[i].isDirectory())
                        .put("bytes", kids[i].isDirectory() ? 0 : kids[i].length()));
                }
                return new JSONObject().put("path", dir.getAbsolutePath()).put("entries", arr).put("total", kids.length);
            }
            case "files.read": {
                File f = safe(params.optString("path", ""));
                if (!f.isFile()) throw new Exception("not a file: " + f);
                if (f.length() > 200_000) throw new Exception("file is over 200 KB; too big to send");
                byte[] data = new byte[(int) f.length()];
                try (FileInputStream in = new FileInputStream(f)) {
                    int off = 0, n;
                    while (off < data.length && (n = in.read(data, off, data.length - off)) > 0) off += n;
                }
                return new JSONObject().put("path", f.getAbsolutePath()).put("text", new String(data, "UTF-8"));
            }
            default: throw new Exception("unknown action " + action);
        }
    }

    /** Only paths inside the phone's shared storage. */
    private static File safe(String path) throws Exception {
        File f = path == null || path.trim().isEmpty() ? ROOT : new File(path.trim());
        if (!f.isAbsolute()) f = new File(ROOT, path.trim());
        String canon = f.getCanonicalPath();
        if (!canon.startsWith(ROOT.getCanonicalPath())) throw new Exception("outside phone storage");
        return new File(canon);
    }
}
