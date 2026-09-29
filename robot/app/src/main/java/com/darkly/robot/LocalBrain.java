package com.darkly.robot;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.os.Environment;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * The robot's own offline brain: llama.cpp's llama-server, compiled for the
 * phone and shipped inside the APK, running a model that is also shipped in
 * the APK (full build) or found on the phone's storage.
 *
 * It starts by itself, restarts itself if it dies, and never needs Termux or
 * internet. Brain.java talks to it on 127.0.0.1:PORT like any other server.
 */
public final class LocalBrain {
    public static final int PORT = 8089;
    public static final String URL = "http://127.0.0.1:" + PORT;

    public enum State { NO_MODEL, UNPACKING, STARTING, READY, CRASHED }

    private final Context ctx;
    private volatile State state = State.STARTING;
    private volatile int unpackPercent = 0;
    private volatile String modelName = "";
    private volatile String lastOutput = "";
    private volatile boolean running = false;
    private Process proc;

    public LocalBrain(Context c) { ctx = c.getApplicationContext(); }

    public State state() { return state; }
    public boolean ready() { return state == State.READY; }
    public String modelName() { return modelName; }
    public String lastOutput() { return lastOutput; }

    public String describe() {
        switch (state) {
            case NO_MODEL: return "Offline brain: no model found";
            case UNPACKING: return "Offline brain: unpacking " + unpackPercent + "% (first run only)";
            case STARTING: return "Offline brain: waking up";
            case READY: return "Offline brain: ready (" + modelName + ")";
            default: return "Offline brain: crashed, restarting";
        }
    }

    public void start() {
        if (running) return;
        running = true;
        Thread t = new Thread(this::supervise, "local-brain");
        t.setDaemon(true);
        t.start();
    }

    public void stop() {
        running = false;
        if (proc != null) proc.destroy();
    }

    /** Keep the server alive for as long as the robot is running. */
    private void supervise() {
        while (running) {
            File model = findOrUnpackModel();
            if (model == null) {
                state = State.NO_MODEL;
                sleep(30000);
                continue;
            }
            modelName = model.getName();
            state = State.STARTING;
            try {
                runServer(model);
            } catch (Exception e) {
                lastOutput = "could not start: " + e.getMessage();
            }
            if (!running) break;
            state = State.CRASHED;
            sleep(5000);
        }
    }

    private void runServer(File model) throws Exception {
        File exe = new File(ctx.getApplicationInfo().nativeLibraryDir, "libllamaserver.so");
        if (!exe.exists()) throw new Exception("model runner missing from this build");
        List<String> cmd = new ArrayList<>();
        cmd.add(exe.getAbsolutePath());
        cmd.add("-m"); cmd.add(model.getAbsolutePath());
        cmd.add("--host"); cmd.add("127.0.0.1");
        cmd.add("--port"); cmd.add(String.valueOf(PORT));
        cmd.add("-c"); cmd.add("4096");
        cmd.add("-t"); cmd.add("4");
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(true);
        pb.directory(ctx.getFilesDir());
        pb.environment().put("HOME", ctx.getFilesDir().getAbsolutePath());
        proc = pb.start();

        // Watch for the server answering on /health while draining its output.
        Thread health = new Thread(() -> {
            while (running && proc != null && proc.isAlive() && state != State.READY) {
                try {
                    Http.Result r = Http.request("GET", URL + "/health", null, null, 3000);
                    if (r.ok()) state = State.READY;
                } catch (Exception ignored) {}
                sleep(1500);
            }
        }, "local-brain-health");
        health.setDaemon(true);
        health.start();

        try (BufferedReader out = new BufferedReader(new InputStreamReader(proc.getInputStream()))) {
            String line;
            while ((line = out.readLine()) != null) lastOutput = line;
        }
        proc.waitFor();
    }

    /**
     * Where the model comes from, in order:
     *  1. Already unpacked into the app's private storage.
     *  2. Shipped inside the APK (full build): copied out once.
     *  3. A .gguf file the owner put on the phone (Download, "Darkly Robot" folder, or storage root).
     */
    private File findOrUnpackModel() {
        File dest = new File(ctx.getFilesDir(), "brain.gguf");
        long bundled = bundledSize();
        if (dest.isFile() && (bundled <= 0 || dest.length() == bundled)) return dest;
        if (bundled > 0) {
            if (unpack(dest, bundled)) return dest;
        }
        File root = Environment.getExternalStorageDirectory();
        File[] places = {
            new File(root, "Darkly Robot"),
            new File(root, "Download"),
            new File(root, "Agent Darkly"),
            root
        };
        for (File dir : places) {
            File[] kids = dir.listFiles();
            if (kids == null) continue;
            for (File f : kids) if (f.isFile() && f.getName().toLowerCase().endsWith(".gguf") && f.length() > 100_000_000L) return f;
        }
        return dest.isFile() && dest.length() > 100_000_000L ? dest : null;
    }

    private long bundledSize() {
        try (AssetFileDescriptor fd = ctx.getAssets().openFd("brain.gguf")) {
            return fd.getLength();
        } catch (Exception e) {
            return -1;
        }
    }

    private boolean unpack(File dest, long total) {
        state = State.UNPACKING;
        unpackPercent = 0;
        File tmp = new File(dest.getAbsolutePath() + ".part");
        try (InputStream in = ctx.getAssets().open("brain.gguf");
             OutputStream out = new FileOutputStream(tmp)) {
            byte[] buf = new byte[1 << 20];
            long done = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                done += n;
                unpackPercent = (int) (done * 100 / Math.max(1, total));
            }
        } catch (Exception e) {
            lastOutput = "unpack failed: " + e.getMessage();
            tmp.delete();
            return false;
        }
        if (dest.exists()) dest.delete();
        return tmp.renameTo(dest);
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }
}
