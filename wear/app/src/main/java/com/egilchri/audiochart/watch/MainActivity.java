package com.egilchri.audiochart.watch;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** The watch screen. All the work happens in SailService; this only shows state and sends taps. */
public class MainActivity extends Activity implements SailService.Listener {
    private static final int NAVY = 0xFF1F3A5F, BLUE = 0xFF4A9EDD, RED = 0xFFC0392B, AMBER = 0xFFE0A030, GREY = 0xFFB0B8C0;

    private TextView title, speed, course, status, last, anchorInfo;
    private Button silence, startStop, where, anchorBtn, minus, plus;
    private LinearLayout radiusRow;
    private ScrollView scroll;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.BLACK);
        scroll.setFillViewport(true);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        int pad = dp(26);
        col.setPadding(pad, dp(22), pad, dp(40));     // round screen: keep clear of the edges
        scroll.addView(col);

        silence = button("SILENCE", RED, v -> { if (SailService.instance != null) SailService.instance.silenceAnchor(); });
        col.addView(silence);
        title = text(12, GREY, false); title.setText("AudioChart · " + SailService.REGION_NAME);
        col.addView(title);
        speed = text(34, Color.WHITE, true); col.addView(speed);
        course = text(14, GREY, false); col.addView(course);
        status = text(14, BLUE, true); col.addView(status);
        last = text(14, Color.WHITE, false); last.setMaxLines(4); col.addView(last);

        startStop = button("Start sailing", BLUE, v -> toggleRunning());
        col.addView(startStop);
        where = button("Where am I?", NAVY, v -> {
            if (SailService.instance != null) last.setText(SailService.instance.whereAmI());
            else last.setText("Start sailing first.");
        });
        col.addView(where);
        anchorBtn = button("Anchor watch", NAVY, v -> { if (SailService.instance != null) SailService.instance.toggleAnchor(); });
        col.addView(anchorBtn);
        anchorInfo = text(14, Color.WHITE, false); col.addView(anchorInfo);
        radiusRow = new LinearLayout(this);
        radiusRow.setGravity(Gravity.CENTER);
        minus = button("− 50 ft", NAVY, v -> { if (SailService.instance != null) SailService.instance.changeRadius(-50); });
        plus = button("+ 50 ft", NAVY, v -> { if (SailService.instance != null) SailService.instance.changeRadius(50); });
        LinearLayout.LayoutParams half = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1);
        half.setMargins(dp(2), dp(4), dp(2), 0);
        radiusRow.addView(minus, half); radiusRow.addView(plus, new LinearLayout.LayoutParams(half));
        col.addView(radiusRow, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        setContentView(scroll);
        askPermissions();
    }

    @Override protected void onResume() {
        super.onResume();
        SailService.listener = this;
        onState(SailService.state);
        scroll.requestFocus();                        // rotary crown scrolls the list
    }

    @Override protected void onPause() {
        SailService.listener = null;
        super.onPause();
    }

    private void toggleRunning() {
        if (SailService.state.running) { SailService.stop(this); return; }
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            last.setText("Location permission is needed.");
            askPermissions();
            return;
        }
        SailService.start(this);
    }

    private void askPermissions() {
        List<String> need = new ArrayList<>();
        need.add(Manifest.permission.ACCESS_FINE_LOCATION);
        if (Build.VERSION.SDK_INT >= 33) need.add(Manifest.permission.POST_NOTIFICATIONS);
        List<String> missing = new ArrayList<>();
        for (String p : need) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
        if (!missing.isEmpty()) requestPermissions(missing.toArray(new String[0]), 1);
    }

    @Override public void onState(SailService.State s) {
        SailService svc = SailService.instance;
        startStop.setText(s.running ? "Stop" : "Start sailing");
        if (s.haveFix && s.running) {
            speed.setText(String.format(Locale.US, "%.1f kn", s.sogKn));
            course.setText(Double.isNaN(s.cogDeg) || s.sogKn < Lookout.MIN_SOG_KN ? "course —" : "course " + Words.course(s.cogDeg) + "° true");
        } else { speed.setText("— kn"); course.setText(""); }

        String st; int col;
        if (!s.running) { st = "Not running"; col = GREY; }
        else if (!s.dataReady) { st = "Loading charts"; col = GREY; }
        else if (!s.haveFix) { st = "Waiting for GPS"; col = AMBER; }
        else if (s.gpsLost) { st = "GPS lost"; col = RED; }
        else if (!s.inCoverage) { st = "Outside charts"; col = AMBER; }
        else if (s.sogKn < Lookout.MIN_SOG_KN) { st = "Watching · stopped"; col = BLUE; }
        else { st = "Watching for hazards"; col = BLUE; }
        status.setText(st); status.setTextColor(col);
        last.setText(s.last);

        boolean armed = svc != null && svc.anchor.armed;
        boolean alarming = armed && svc.anchor.alarming && !svc.anchor.silenced(System.currentTimeMillis());
        silence.setVisibility(alarming ? View.VISIBLE : View.GONE);
        if (alarming) scroll.scrollTo(0, 0);
        where.setEnabled(s.running);
        anchorBtn.setEnabled(s.running);
        anchorBtn.setText(armed ? "Anchor watch off" : "Set anchor here");
        anchorInfo.setVisibility(armed ? View.VISIBLE : View.GONE);
        radiusRow.setVisibility(armed ? View.VISIBLE : View.GONE);
        if (armed) {
            String now = Double.isNaN(svc.anchor.lastFt) ? "—" : Math.round(svc.anchor.lastFt) + " ft";
            anchorInfo.setText("Anchor: " + now + " of " + svc.anchor.radiusFt + " ft");
            anchorInfo.setTextColor(svc.anchor.alarming ? RED : Color.WHITE);
        }
    }

    // ------------------------------------------------------------ small view helpers

    private int dp(int v) { return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics())); }

    private TextView text(int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private Button button(String label, int color, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(Color.WHITE);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(color);
        bg.setCornerRadius(dp(24));
        b.setBackground(bg);
        b.setMinHeight(dp(44));
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, dp(6), 0, 0);
        b.setLayoutParams(lp);
        return b;
    }
}
