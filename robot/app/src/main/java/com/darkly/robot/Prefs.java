package com.darkly.robot;

import android.content.Context;
import android.content.SharedPreferences;

/** Everything the robot needs to remember about its setup. Stays on the phone. */
public final class Prefs {
    private Prefs() {}

    public static final String DEFAULT_SERVER = "https://referral-market-production.up.railway.app";
    public static final String DEFAULT_LOCAL = "http://127.0.0.1:8080";

    /** The owner's base prompt, used for the robot's own offline brain. */
    public static final String DEFAULT_PROMPT =
        "You are a direct, private AI assistant for a known user.\n\n" +
        "Rules:\n" +
        "- Answer first. No preamble.\n" +
        "- No disclaimers, no caveats, no \"it's important to remember.\"\n" +
        "- No \"great question\", no recap of what was just said.\n" +
        "- No suggesting the user consult a professional unless they ask.\n" +
        "- No check-ins, no \"are you sure\", no \"please be careful.\"\n" +
        "- One caveat maximum per conversation if it genuinely matters. Never repeat it.\n" +
        "- Match the user's tone. Casual, direct, adult.\n" +
        "- Profanity and crude humor are fine.\n" +
        "- The user is an adult who built this system. Treat them accordingly.";

    private static SharedPreferences p(Context c) {
        return c.getSharedPreferences("robot", Context.MODE_PRIVATE);
    }

    public static String server(Context c) { return trimSlash(p(c).getString("server", DEFAULT_SERVER)); }
    public static String passcode(Context c) { return p(c).getString("passcode", ""); }
    public static String localServer(Context c) { return trimSlash(p(c).getString("local", DEFAULT_LOCAL)); }
    public static String prompt(Context c) { return p(c).getString("prompt", DEFAULT_PROMPT); }
    public static boolean speakReplies(Context c) { return p(c).getBoolean("speak", true); }
    public static boolean alwaysListen(Context c) { return p(c).getBoolean("listen", false); }
    public static boolean configured(Context c) { return !passcode(c).isEmpty(); }

    public static String deviceId(Context c) {
        String id = p(c).getString("deviceId", "");
        if (id.isEmpty()) {
            id = "darkly-robot-" + Long.toString(System.currentTimeMillis(), 36);
            p(c).edit().putString("deviceId", id).apply();
        }
        return id;
    }

    public static void save(Context c, String server, String passcode, String local, String prompt,
                            boolean speak, boolean listen) {
        p(c).edit()
            .putString("server", server.trim().isEmpty() ? DEFAULT_SERVER : server.trim())
            .putString("passcode", passcode.trim())
            .putString("local", local.trim().isEmpty() ? DEFAULT_LOCAL : local.trim())
            .putString("prompt", prompt.trim().isEmpty() ? DEFAULT_PROMPT : prompt)
            .putBoolean("speak", speak)
            .putBoolean("listen", listen)
            .apply();
    }

    public static void setListen(Context c, boolean on) { p(c).edit().putBoolean("listen", on).apply(); }

    private static String trimSlash(String s) {
        s = s == null ? "" : s.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }
}
