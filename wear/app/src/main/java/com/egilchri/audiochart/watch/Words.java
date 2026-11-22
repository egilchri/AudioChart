package com.egilchri.audiochart.watch;

import java.util.Locale;

/** Spoken wording, kept the same as the web app (utils.js formatDistance). */
final class Words {
    private Words() {}

    static String distance(double nm) {
        if (nm < 0.01) return "very close";
        if (nm < 0.1) return "about " + Math.round(nm * 2025 / 50) * 50 + " yards";
        return String.format(Locale.US, "%.1f nautical miles", nm);
    }

    static String feet(double ft) { long f = Math.round(ft); return f + (f == 1 ? " foot" : " feet"); }

    /** Bearing of a target relative to the bow, -180..180 (negative = port). */
    static double relBearing(double bearingDeg, double headingDeg) {
        double r = ((bearingDeg - headingDeg) % 360 + 540) % 360 - 180;
        return r;
    }

    static String side(double rel) {
        double a = Math.abs(rel);
        String s = rel < 0 ? "port" : "starboard";
        if (a < 8) return "dead ahead";
        if (a < 30) return "fine on the " + s + " bow";
        if (a < 70) return "on the " + s + " bow";
        if (a < 110) return "abeam to " + s;
        if (a < 160) return "on the " + s + " quarter";
        return "astern";
    }

    private static final String[] COMPASS = {"north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"};

    static String compass(double brgDeg) {
        int i = (int) Math.round(((brgDeg % 360) + 360) % 360 / 45.0) % 8;
        return COMPASS[i];
    }

    static String course(double deg) {
        return String.format(Locale.US, "%03d", Math.round(((deg % 360) + 360) % 360) % 360);
    }
}
