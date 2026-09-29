package com.darkly.robot;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/** Plain HTTP with JSON. Always called off the main thread. */
public final class Http {
    private Http() {}

    public static final class Result {
        public final int status;
        public final String body;
        Result(int status, String body) { this.status = status; this.body = body; }
        public boolean ok() { return status >= 200 && status < 300; }
        public JSONObject json() {
            try { return new JSONObject(body); } catch (Exception e) { return new JSONObject(); }
        }
    }

    public static Result request(String method, String url, JSONObject body, Map<String, String> headers,
                                 int timeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(Math.min(timeoutMs, 8000));
        c.setReadTimeout(timeoutMs);
        c.setRequestProperty("Accept", "application/json");
        if (headers != null) for (Map.Entry<String, String> h : headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
        if (body != null) {
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream os = c.getOutputStream()) { os.write(bytes); }
        }
        int status = c.getResponseCode();
        InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
        String text = "";
        if (in != null) {
            try (InputStream is = in) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
                text = out.toString("UTF-8");
            }
        }
        c.disconnect();
        return new Result(status, text);
    }
}
