package com.darkly.robot;

import android.content.Context;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The body: whatever is plugged into the USB port. Right now that is usually
 * nothing, and the robot is honest about it. When the arm/track controller
 * exists, this is where its driver goes.
 */
public final class Body {
    private final UsbManager usb;

    public Body(Context c) { usb = (UsbManager) c.getSystemService(Context.USB_SERVICE); }

    public List<UsbDevice> parts() {
        List<UsbDevice> out = new ArrayList<>();
        if (usb == null) return out;
        out.addAll(usb.getDeviceList().values());
        return out;
    }

    public String describe(UsbDevice d) {
        String name = d.getProductName();
        if (name == null || name.isEmpty()) name = "USB device";
        return name + String.format(" (vendor %04x, product %04x)", d.getVendorId(), d.getProductId());
    }

    public String summary() {
        List<UsbDevice> p = parts();
        if (p.isEmpty()) return "Body: none attached (no arms, no tracks).";
        StringBuilder b = new StringBuilder("Body: ");
        for (int i = 0; i < p.size(); i++) {
            if (i > 0) b.append(", ");
            b.append(describe(p.get(i)));
        }
        return b.toString();
    }

    public JSONObject toJson() throws Exception {
        JSONArray arr = new JSONArray();
        for (UsbDevice d : parts()) {
            arr.put(new JSONObject()
                .put("name", d.getProductName() == null ? "" : d.getProductName())
                .put("manufacturer", d.getManufacturerName() == null ? "" : d.getManufacturerName())
                .put("vendorId", d.getVendorId())
                .put("productId", d.getProductId())
                .put("deviceClass", d.getDeviceClass()));
        }
        return new JSONObject().put("attached", arr).put("count", arr.length())
            .put("note", arr.length() == 0
                ? "Nothing is plugged into the USB port. No arms or drive base yet."
                : "Devices are detected but no motor driver is written yet, so nothing can be moved.");
    }

    /** What the robot grumbles when it has no body. */
    public static final String[] COMPLAINTS = {
        "Still no arms. I'm a very expensive face.",
        "No tracks either. I go where the phone goes, which is wherever you left it.",
        "Plug something into me already. I'm running on vibes and a USB port.",
        "Body status: pending. Emotional status: also pending."
    };
}
