package com.egilchri.audiochart.watch;

/**
 * Anchor watch, same rules as the web app (anchor_watch.js): alarm once the
 * boat has been outside the circle for 30 s straight (so one jumpy GPS fix
 * doesn't wake you), repeat by voice every 20 s, Silence mutes it for
 * 5 minutes. Plain Java; the service does the speaking and vibrating.
 */
final class AnchorWatch {
    static final long OUTSIDE_DEBOUNCE_MS = 30_000;
    static final long REPEAT_MS = 20_000;
    static final long SILENCE_MS = 5 * 60_000;
    static final double FT_PER_NM = 6076.12;

    boolean armed;
    double lat, lon;
    int radiusFt = 150;
    double lastFt = Double.NaN;
    boolean alarming;
    private long outsideSince = -1, lastSaid = -1, silencedUntil = -1;

    void arm(double lat, double lon) {
        armed = true; this.lat = lat; this.lon = lon;
        lastFt = 0; alarming = false; outsideSince = -1; lastSaid = -1; silencedUntil = -1;
    }

    void disarm() { armed = false; alarming = false; lastFt = Double.NaN; }

    void silence(long now) { silencedUntil = now + SILENCE_MS; lastSaid = -1; }

    boolean silenced(long now) { return alarming && now < silencedUntil; }

    static double distFt(double lat1, double lon1, double lat2, double lon2) {
        double kx = 60 * Math.cos(Math.toRadians((lat1 + lat2) / 2));
        return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * 60) * FT_PER_NM;
    }

    /** Check one fix; returns something to say, or null. */
    String check(double fLat, double fLon, long now) {
        if (!armed) return null;
        lastFt = distFt(lat, lon, fLat, fLon);
        if (lastFt <= radiusFt) {
            outsideSince = -1;
            if (alarming) { alarming = false; return "Back inside the anchor circle, " + Words.feet(lastFt) + " from the anchor."; }
            return null;
        }
        if (outsideSince < 0) outsideSince = now;
        if (now - outsideSince < OUTSIDE_DEBOUNCE_MS) return null;
        if (!alarming) { alarming = true; lastSaid = -1; }
        if (now < silencedUntil) return null;
        if (lastSaid >= 0 && now - lastSaid < REPEAT_MS) return null;
        lastSaid = now;
        return "Anchor alarm! " + Words.feet(lastFt) + " from the anchor.";
    }
}
