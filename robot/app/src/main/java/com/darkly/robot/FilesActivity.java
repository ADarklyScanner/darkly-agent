package com.darkly.robot;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;
import java.io.FileInputStream;
import java.util.Arrays;

/** Walk the phone's storage from the robot screen, read text files. */
public class FilesActivity extends Activity {
    private File root, current;
    private LinearLayout list;
    private TextView pathView;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        root = Environment.getExternalStorageDirectory();
        current = root;

        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setBackgroundColor(Color.rgb(10, 10, 12));
        page.setPadding(dp(12), dp(28), dp(12), dp(12));

        LinearLayout top = new LinearLayout(this);
        Button up = btn("Up", v -> { if (!current.equals(root)) { current = current.getParentFile(); show(); } });
        Button back = btn("Back to robot", v -> finish());
        top.addView(up);
        top.addView(back);
        page.addView(top);

        pathView = new TextView(this);
        pathView.setTextColor(Color.rgb(120, 120, 130));
        pathView.setTypeface(Typeface.MONOSPACE);
        pathView.setPadding(0, dp(8), 0, dp(8));
        page.addView(pathView);

        ScrollView sv = new ScrollView(this);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        sv.addView(list);
        page.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1f));

        setContentView(page);
        show();
    }

    private void show() {
        pathView.setText(current.getAbsolutePath());
        list.removeAllViews();
        File[] kids = current.listFiles();
        if (kids == null) {
            boolean needs = Build.VERSION.SDK_INT >= 30 && !Environment.isExternalStorageManager();
            list.addView(row(needs ? "Can't read storage yet. Robot → Setup → \"Give it access to all files\"." : "Can't open this folder.", null, false));
            return;
        }
        Arrays.sort(kids, (a, b) -> a.isDirectory() != b.isDirectory() ? (a.isDirectory() ? -1 : 1) : a.getName().compareToIgnoreCase(b.getName()));
        if (kids.length == 0) list.addView(row("(empty)", null, false));
        for (File f : kids) list.addView(row(f.getName() + (f.isDirectory() ? "/" : "  · " + size(f.length())), f, f.isDirectory()));
    }

    private TextView row(String label, File f, boolean folder) {
        TextView t = new TextView(this);
        t.setText(label);
        t.setTextSize(16);
        t.setTypeface(Typeface.MONOSPACE);
        t.setTextColor(folder ? Color.rgb(104, 229, 156) : Color.rgb(225, 225, 230));
        t.setPadding(dp(4), dp(10), dp(4), dp(10));
        if (f != null) t.setOnClickListener(v -> { if (f.isDirectory()) { current = f; show(); } else open(f); });
        return t;
    }

    private void open(File f) {
        String body;
        if (f.length() > 200_000) body = "Too big to show here (" + size(f.length()) + ").";
        else {
            try {
                byte[] data = new byte[(int) f.length()];
                try (FileInputStream in = new FileInputStream(f)) {
                    int off = 0, n;
                    while (off < data.length && (n = in.read(data, off, data.length - off)) > 0) off += n;
                }
                body = new String(data, "UTF-8");
                if (body.indexOf('\u0000') >= 0) body = "Not a text file.";
            } catch (Exception e) { body = "Could not read: " + e.getMessage(); }
        }
        TextView tv = new TextView(this);
        tv.setText(body);
        tv.setTypeface(Typeface.MONOSPACE);
        tv.setTextIsSelectable(true);
        tv.setPadding(dp(16), dp(8), dp(16), dp(8));
        ScrollView sv = new ScrollView(this);
        sv.addView(tv);
        new AlertDialog.Builder(this).setTitle(f.getName()).setView(sv).setPositiveButton("Close", null).show();
    }

    private static String size(long b) {
        if (b < 1024) return b + " B";
        if (b < 1024 * 1024) return (b / 1024) + " KB";
        return String.format("%.1f MB", b / 1048576.0);
    }

    private Button btn(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(Color.rgb(104, 229, 156));
        b.setBackgroundColor(Color.rgb(30, 44, 36));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
        lp.setMargins(0, 0, dp(8), 0);
        b.setLayoutParams(lp);
        b.setOnClickListener(l);
        return b;
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
}
