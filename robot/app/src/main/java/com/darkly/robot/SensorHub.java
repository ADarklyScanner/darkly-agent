package com.darkly.robot;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.BatteryManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The phone's senses. Keeps the latest value of each, and hands a batch to the
 * engine's /sensor-reading intake (which already knows light, motion, battery,
 * steps and pressure by name).
 */
public final class SensorHub implements SensorEventListener {
    private final Context ctx;
    private final SensorManager sm;
    private final Map<String, Double> latest = new HashMap<>();
    private final Map<String, String> units = new HashMap<>();
    private float[] lastAccel;

    public SensorHub(Context c) {
        ctx = c.getApplicationContext();
        sm = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
    }

    public void start() {
        if (sm == null) return;
        listen(Sensor.TYPE_LIGHT);
        listen(Sensor.TYPE_ACCELEROMETER);
        listen(Sensor.TYPE_PRESSURE);
        listen(Sensor.TYPE_STEP_COUNTER);
        listen(Sensor.TYPE_AMBIENT_TEMPERATURE);
        listen(Sensor.TYPE_PROXIMITY);
    }

    public void stop() { if (sm != null) sm.unregisterListener(this); }

    private void listen(int type) {
        Sensor s = sm.getDefaultSensor(type);
        if (s != null) sm.registerListener(this, s, SensorManager.SENSOR_DELAY_NORMAL);
    }

    @Override
    public synchronized void onSensorChanged(SensorEvent e) {
        switch (e.sensor.getType()) {
            case Sensor.TYPE_LIGHT: put("light", e.values[0], "lux"); break;
            case Sensor.TYPE_PRESSURE: put("pressure", e.values[0], "hPa"); break;
            case Sensor.TYPE_STEP_COUNTER: put("steps", e.values[0], "steps since boot"); break;
            case Sensor.TYPE_AMBIENT_TEMPERATURE: put("temperature", e.values[0], "C"); break;
            case Sensor.TYPE_PROXIMITY: put("proximity", e.values[0], "cm"); break;
            case Sensor.TYPE_ACCELEROMETER: {
                // Motion = how much the reading changed, so a phone lying still reads ~0.
                if (lastAccel != null) {
                    double d = Math.sqrt(sq(e.values[0] - lastAccel[0]) + sq(e.values[1] - lastAccel[1]) + sq(e.values[2] - lastAccel[2]));
                    Double prev = latest.get("motion");
                    put("motion", prev == null ? d : prev * 0.8 + d * 0.2, "m/s2 change");
                }
                lastAccel = e.values.clone();
                break;
            }
            default: break;
        }
    }

    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    private static double sq(double v) { return v * v; }

    private void put(String name, double v, String unit) {
        latest.put(name, v);
        units.put(name, unit);
    }

    public int battery() {
        Intent b = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (b == null) return -1;
        int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
        return level < 0 ? -1 : Math.round(level * 100f / scale);
    }

    public boolean charging() {
        Intent b = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (b == null) return false;
        int s = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
        return s == BatteryManager.BATTERY_STATUS_CHARGING || s == BatteryManager.BATTERY_STATUS_FULL;
    }

    /** Readings in the shape /sensor-reading expects. */
    public synchronized JSONArray readings() throws Exception {
        JSONArray arr = new JSONArray();
        for (Map.Entry<String, Double> e : latest.entrySet()) {
            arr.put(new JSONObject().put("sensor", e.getKey())
                .put("value", Math.round(e.getValue() * 100.0) / 100.0)
                .put("unit", units.get(e.getKey())));
        }
        int bat = battery();
        if (bat >= 0) arr.put(new JSONObject().put("sensor", "battery").put("value", bat).put("unit", "%")
            .put("meta", new JSONObject().put("charging", charging())));
        return arr;
    }

    public synchronized JSONObject snapshot() throws Exception {
        JSONObject o = new JSONObject();
        for (Map.Entry<String, Double> e : latest.entrySet()) o.put(e.getKey(), Math.round(e.getValue() * 100.0) / 100.0);
        o.put("battery", battery());
        o.put("charging", charging());
        JSONArray all = new JSONArray();
        if (sm != null) {
            List<Sensor> list = sm.getSensorList(Sensor.TYPE_ALL);
            for (Sensor s : list) all.put(s.getName());
        }
        o.put("hardwareSensors", all);
        return o;
    }

    public synchronized String shortLine() {
        StringBuilder b = new StringBuilder();
        int bat = battery();
        b.append("Battery ").append(bat < 0 ? "?" : bat + "%").append(charging() ? " charging" : "");
        Double light = latest.get("light");
        if (light != null) b.append(" · light ").append(Math.round(light)).append(" lux");
        Double motion = latest.get("motion");
        if (motion != null) b.append(motion > 0.5 ? " · moving" : " · still");
        return b.toString();
    }
}
