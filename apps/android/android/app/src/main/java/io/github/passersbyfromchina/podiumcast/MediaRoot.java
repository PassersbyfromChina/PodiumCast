package io.github.passersbyfromchina.podiumcast;

import android.content.Context;

import java.io.File;

/**
 * Where PodiumCast keeps recordings on Android.
 *
 * `getExternalFilesDir` (app-specific external storage) rather than shared storage, for three
 * reasons:
 *
 *   1. no runtime permission is needed on any supported API level (24+),
 *   2. the files are still ordinary files the user can reach over USB / a file manager,
 *      unlike app-internal storage,
 *   3. nothing else on the device can read them, which matters for footage of people.
 *
 * It is removed when the app is uninstalled, exactly like every other camera app's private
 * album.
 */
final class MediaRoot {

    private MediaRoot() { }

    static File dir(Context context) {
        File base = context.getExternalFilesDir(null);
        if (base == null) base = context.getFilesDir();
        File dir = new File(base, "PodiumCast");
        if (!dir.exists() && !dir.mkdirs()) {
            // Fall back to internal storage rather than failing a recording.
            dir = new File(context.getFilesDir(), "PodiumCast");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
        return dir;
    }

    static File photos(Context context) { return sub(context, "photos"); }

    static File videos(Context context) { return sub(context, "videos"); }

    static File index(Context context) { return new File(dir(context), ".podiumcast-index.json"); }

    private static File sub(Context context, String name) {
        File f = new File(dir(context), name);
        if (!f.exists() && !f.mkdirs()) {
            //noinspection ResultOfMethodCallIgnored
            f.mkdirs();
        }
        return f;
    }
}
