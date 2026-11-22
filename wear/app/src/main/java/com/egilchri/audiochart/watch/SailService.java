package com.egilchri.audiochart.watch;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.speech.tts.TextToSpeech;
import android.util.Log;

import java.util.ArrayDeque;
import java.util.List;
import java.util.Locale;

/**
 * Runs while sailing, screen on or off: watch GPS -> Lookout + AnchorWatch ->
 * speech and vibration. Everything is on the watch; no phone, no network.
 * A foreground service with a partial wake lock, so it keeps going with the
 * screen dark.
 */
public class SailService extends Service implements LocationListener {
    static final String TAG = "AudioChartWatch";
    static final String REGION = "penobscot-bay";
    static final String REGION_NAME = "Penobscot Bay";
    private static final String CHANNEL = "sailing";
    private static final long GPS_LOST_MS = 30_000;
    private static final double MAX_PLAUSIBLE_KN = 30;

    /** What the screen shows; read by MainActivity. */
    static final class State {
        boolean running, haveFix, inCoverage = true, gpsLost, dataReady;
        double lat, lon, sogKn, cogDeg = Double.NaN;
        String last = "";
    }

    interface Listener { void onState(State s); }

    static volatile SailService instance;
    static Listener listener;
    static final State state = new State();

    final AnchorWatch anchor = new AnchorWatch();
    private Lookout lookout;
    private TextToSpeech tts;
    private boolean ttsReady;
    private final ArrayDeque<String> pending = new ArrayDeque<>();
    private Vibrator vibrator;
    private PowerManager.WakeLock wake;
    private final Handler main = new Handler(Looper.getMainLooper());

    private Location prev;            // for course/speed when the fix itself has none
    private long lastFixMs;
    private boolean coverageSaid;

    static void start(Context ctx) { ctx.startForegroundService(new Intent(ctx, SailService.class)); }
    static void stop(Context ctx) { ctx.stopService(new Intent(ctx, SailService.class)); }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Sailing", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle("AudioChart")
                .setContentText("Watching for hazards")
                .setContentIntent(open)
                .setOngoing(true)
                .build();
        startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);

        wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AudioChart:sailing");
        wake.acquire();
        vibrator = getSystemService(Vibrator.class);

        tts = new TextToSpeech(this, status -> {
            if (status != TextToSpeech.SUCCESS) { Log.e(TAG, "TTS init failed: " + status); return; }
            tts.setLanguage(Locale.US);
            // alarm stream: heard even when media volume is down
            tts.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            ttsReady = true;
            while (!pending.isEmpty()) speakNow(pending.poll());
        });

        state.running = true; state.haveFix = false; state.gpsLost = false;
        state.last = "Loading charts…";
        push();
        new Thread(() -> {
            try {
                ChartData c = ChartData.load(getAssets().open(REGION + ".bin"));
                main.post(() -> {
                    lookout = new Lookout(c);
                    state.dataReady = true;
                    Log.i(TAG, "charts loaded: " + c.hLon.length + " hazards");
                    say(REGION_NAME + " charts loaded. Waiting for GPS.", false);
                    startGps();
                });
            } catch (Exception e) {
                Log.e(TAG, "chart load failed", e);
                main.post(() -> say("Chart data failed to load.", true));
            }
        }).start();
        main.postDelayed(gpsWatchdog, GPS_LOST_MS);
    }

    @SuppressWarnings("MissingPermission")
    private void startGps() {
        LocationManager lm = getSystemService(LocationManager.class);
        try {
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, this, Looper.getMainLooper());
        } catch (SecurityException e) {
            say("Location permission is needed.", true);
        }
    }

    private final Runnable gpsWatchdog = new Runnable() {
        @Override public void run() {
            long now = System.currentTimeMillis();
            if (state.haveFix && !state.gpsLost && now - lastFixMs > GPS_LOST_MS) {
                state.gpsLost = true;
                say("GPS signal lost. No hazard warnings until it returns.", true);
            }
            main.postDelayed(this, 5000);
        }
    };

    @Override public void onLocationChanged(Location loc) {
        long now = System.currentTimeMillis();
        lastFixMs = now;
        if (state.gpsLost) { state.gpsLost = false; say("GPS back.", false); }
        boolean first = !state.haveFix;
        state.haveFix = true;
        state.lat = loc.getLatitude(); state.lon = loc.getLongitude();

        // course and speed: from the fix when it has them, else from the move since the last fix
        if (loc.hasSpeed() && loc.hasBearing() && loc.getSpeed() > 0.3f) {
            state.sogKn = loc.getSpeed() * 1.943844;
            state.cogDeg = loc.getBearing();
            prev = loc;
        } else if (prev == null) {
            prev = loc;
        } else {
            float d = prev.distanceTo(loc);
            long dt = loc.getElapsedRealtimeNanos() - prev.getElapsedRealtimeNanos();
            if (dt <= 0) dt = (loc.getTime() - prev.getTime()) * 1_000_000L;
            if (d >= 15 && dt > 0) {
                double kn = d / (dt / 1e9) * 1.943844;
                if (kn > MAX_PLAUSIBLE_KN) {            // a GPS jump, not boat speed: start over from here
                    Log.w(TAG, String.format(Locale.US, "GPS jump ignored (%.0f m, %.0f kn)", d, kn));
                    prev = loc;                         // keep the last real speed and course
                } else {
                    // smooth: GPS fixes arrive unevenly, and the look-ahead length follows speed
                    state.sogKn = state.sogKn > 0 ? 0.6 * state.sogKn + 0.4 * kn : kn;
                    state.cogDeg = prev.bearingTo(loc);
                    prev = loc;
                }
            } else if (dt > 20_000_000_000L) {     // 20 s and barely moved: stopped
                state.sogKn = 0;
                prev = loc;
            }
        }

        if (lookout != null) {
            boolean in = lookout.covers(state.lat, state.lon);
            if (!in && (state.inCoverage || first)) {
                say("Outside " + REGION_NAME + " chart coverage. No hazard warnings here.", true);
            } else if (in && !state.inCoverage) {
                say("Back in " + REGION_NAME + " charts.", false);
            } else if (in && first) {
                say("GPS fix. Watching for hazards.", false);
            }
            state.inCoverage = in;
            if (in) {
                List<Lookout.Alert> alerts = lookout.update(state.lat, state.lon, state.cogDeg, state.sogKn, now);
                for (Lookout.Alert a : alerts) say(a.text, a.urgent);
            }
        }

        String a = anchor.check(state.lat, state.lon, now);
        if (a != null) say(a, anchor.alarming);
        if (anchor.alarming && !anchor.silenced(now) && a != null) alarmBuzz();
        push();
    }

    // older API levels still call these
    @Override public void onStatusChanged(String p, int s, Bundle b) {}
    @Override public void onProviderEnabled(String p) {}
    @Override public void onProviderDisabled(String p) { say("GPS is turned off.", true); }

    // ------------------------------------------------------------ actions from the screen

    String whereAmI() {
        if (!state.haveFix) return "No GPS fix yet.";
        if (lookout == null) return "Charts still loading.";
        StringBuilder s = new StringBuilder(lookout.whereAmI(state.lat, state.lon));
        if (!lookout.covers(state.lat, state.lon)) s.insert(0, "Outside " + REGION_NAME + " charts. ");
        if (state.sogKn >= Lookout.MIN_SOG_KN && !Double.isNaN(state.cogDeg))
            s.append(String.format(Locale.US, " Making %.1f knots, course %s true.", state.sogKn, Words.course(state.cogDeg)));
        say(s.toString(), false);
        return s.toString();
    }

    void toggleAnchor() {
        if (anchor.armed) { anchor.disarm(); say("Anchor watch off.", false); }
        else if (!state.haveFix) say("No GPS fix yet, can't set the anchor.", false);
        else { anchor.arm(state.lat, state.lon); say("Anchor watch set, " + Words.feet(anchor.radiusFt) + ".", false); }
        push();
    }

    void changeRadius(int deltaFt) {
        anchor.radiusFt = Math.max(50, Math.min(1000, anchor.radiusFt + deltaFt));
        say(Words.feet(anchor.radiusFt) + ".", false);
        push();
    }

    void silenceAnchor() {
        anchor.silence(System.currentTimeMillis());
        if (vibrator != null) vibrator.cancel();
        say("Silenced for 5 minutes.", false);
        push();
    }

    // ------------------------------------------------------------ output

    void say(String text, boolean urgent) {
        Log.i(TAG, (urgent ? "SAY!: " : "SAY: ") + text);
        state.last = text;
        if (urgent) alarmBuzz(); else buzz();
        if (ttsReady) speakNow(text); else pending.add(text);
        push();
    }

    private void speakNow(String text) {
        tts.speak(text, TextToSpeech.QUEUE_ADD, null, "u" + System.nanoTime());
    }

    private void buzz() {
        if (vibrator != null) vibrator.vibrate(VibrationEffect.createOneShot(150, VibrationEffect.DEFAULT_AMPLITUDE));
    }

    private void alarmBuzz() {
        if (vibrator != null)
            vibrator.vibrate(VibrationEffect.createWaveform(new long[]{0, 400, 150, 400, 150, 400}, -1));
    }

    private void push() {
        Listener l = listener;
        if (l != null) main.post(() -> l.onState(state));
    }

    @Override public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        getSystemService(LocationManager.class).removeUpdates(this);
        if (tts != null) { tts.stop(); tts.shutdown(); }
        if (vibrator != null) vibrator.cancel();
        if (wake != null && wake.isHeld()) wake.release();
        instance = null;
        state.running = false; state.haveFix = false;
        state.last = "Stopped.";
        push();
        super.onDestroy();
    }
}
