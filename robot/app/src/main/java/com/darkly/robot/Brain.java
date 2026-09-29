package com.darkly.robot;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Where thinking happens, in order:
 *  1. Darkly Agent on Railway (Claude, with the engine's tools and main chat memory).
 *  2. A model running on this phone (llama-server in Termux), using the owner's base prompt.
 *  3. Nothing: the robot says plainly that it has no brain right now.
 * It always reports which one answered. It never pretends a fallback is the real thing.
 */
public final class Brain {
    public enum Source { ENGINE, LOCAL, NONE }

    public static final class Reply {
        public final String text;
        public final Source source;
        public final String note;
        Reply(String text, Source source, String note) { this.text = text; this.source = source; this.note = note; }
    }

    private final Context ctx;
    private final List<JSONObject> localHistory = new ArrayList<>();

    public Brain(Context ctx) { this.ctx = ctx.getApplicationContext(); }

    public Reply think(String said, String bodyReport) {
        String engineError = null;
        if (Prefs.configured(ctx)) {
            try {
                JSONObject body = new JSONObject();
                body.put("message", "[Robot body on the S22, spoken to it by the owner. " + bodyReport + "]\n" + said);
                Map<String, String> h = new HashMap<>();
                h.put("X-Agent-Passcode", Prefs.passcode(ctx));
                h.put("X-Session-Id", "chat");
                Http.Result r = Http.request("POST", Prefs.server(ctx) + "/chat", body, h, 150000);
                if (r.status == 401) return new Reply("Engine says the passcode is wrong. Fix it in Setup.", Source.NONE, "passcode rejected");
                JSONObject j = r.json();
                if (r.ok() && j.optString("reply", "").length() > 0) {
                    remember("user", said);
                    remember("assistant", j.optString("reply"));
                    return new Reply(j.optString("reply"), Source.ENGINE, j.optString("provider", ""));
                }
                engineError = j.optString("error", "status " + r.status);
            } catch (Exception e) {
                engineError = e.getClass().getSimpleName() + ": " + e.getMessage();
            }
        } else {
            engineError = "no passcode set";
        }

        try {
            JSONArray msgs = new JSONArray();
            msgs.put(new JSONObject().put("role", "system").put("content",
                Prefs.prompt(ctx) + "\n\nYou are running offline inside a robot body on the owner's Galaxy S22. " +
                "The main engine (Darkly Agent) is unreachable right now, so you have no tools and no internet. " + bodyReport));
            for (JSONObject m : localHistory) msgs.put(m);
            msgs.put(new JSONObject().put("role", "user").put("content", said));
            JSONObject body = new JSONObject().put("messages", msgs).put("max_tokens", 220).put("stream", false);
            Http.Result r = Http.request("POST", Prefs.localServer(ctx) + "/v1/chat/completions", body, null, 120000);
            if (r.ok()) {
                String text = r.json().getJSONArray("choices").getJSONObject(0).getJSONObject("message").optString("content", "").trim();
                if (!text.isEmpty()) {
                    remember("user", said);
                    remember("assistant", text);
                    return new Reply(text, Source.LOCAL, "engine unreachable: " + engineError);
                }
            }
        } catch (Exception ignored) { /* no local model running */ }

        return new Reply("No brain right now. Engine's unreachable (" + engineError + ") and there's no local model running. " +
            "Start one in Termux and I'll use it.", Source.NONE, engineError);
    }

    private void remember(String role, String content) {
        try { localHistory.add(new JSONObject().put("role", role).put("content", content)); } catch (Exception ignored) {}
        while (localHistory.size() > 12) localHistory.remove(0);
    }
}
