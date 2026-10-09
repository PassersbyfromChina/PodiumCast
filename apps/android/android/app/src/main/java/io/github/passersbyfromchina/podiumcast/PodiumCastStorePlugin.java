package io.github.passersbyfromchina.podiumcast;

import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * PodiumCastStore — append-only media storage for Android.
 *
 * The Capacitor Filesystem plugin would work for small photos, but every one of its calls
 * closes over the *whole* file as base64. A file transfer moves 255 KiB slices, so reading a
 * 4 GB clip through it would be quadratic both in time and in peak memory. This plugin keeps
 * an open {@link RandomAccessFile} per in-flight write and supports true range reads, which is
 * what `MediaStore.readRange` in packages/core/src/bridge.ts promises every platform.
 *
 * All file IO runs on a worker thread: blocking Capacitor's bridge thread would freeze the
 * live preview, which is the one thing the Stage must never see stutter.
 */
@CapacitorPlugin(name = "PodiumCastStore")
public class PodiumCastStorePlugin extends Plugin {

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String, Writer> writers = new ConcurrentHashMap<>();

    private static final class Writer {
        final RandomAccessFile file;
        final Entry entry;
        long bytes;

        Writer(RandomAccessFile file, Entry entry) {
            this.file = file;
            this.entry = entry;
        }
    }

    /** One row of `.podiumcast-index.json`, mirroring MediaFile in the shared protocol. */
    private static final class Entry {
        String id;
        String name;
        String kind;
        String mime;
        int width;
        int height;
        long durationMs;
        long createdAt;
        String dir;

        JSONObject toJson() throws Exception {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("name", name);
            o.put("kind", kind);
            o.put("mime", mime);
            o.put("width", width);
            o.put("height", height);
            o.put("durationMs", durationMs);
            o.put("createdAt", createdAt);
            o.put("dir", dir);
            return o;
        }

        static Entry fromJson(JSONObject o) {
            Entry e = new Entry();
            e.id = o.optString("id");
            e.name = o.optString("name");
            e.kind = o.optString("kind", "video");
            e.mime = o.optString("mime", "video/webm");
            e.width = o.optInt("width");
            e.height = o.optInt("height");
            e.durationMs = o.optLong("durationMs");
            e.createdAt = o.optLong("createdAt");
            e.dir = o.optString("dir", "videos");
            return e;
        }
    }

    @Override
    protected void handleOnDestroy() {
        for (Writer w : writers.values()) {
            try { w.file.close(); } catch (Exception ignored) { }
        }
        writers.clear();
        io.shutdownNow();
    }

    // ------------------------------------------------------------------ listing

    @PluginMethod
    public void list(PluginCall call) {
        io.execute(() -> {
            try {
                JSArray array = new JSArray();
                for (Entry entry : readIndex()) {
                    File file = fileFor(entry);
                    if (!file.exists()) continue;
                    array.put(toJs(entry, file.length()));
                }
                JSObject out = new JSObject();
                out.put("files", array);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("读取拍摄库失败：" + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void location(PluginCall call) {
        JSObject out = new JSObject();
        out.put("path", MediaRoot.dir(getContext()).getAbsolutePath());
        call.resolve(out);
    }

    // ------------------------------------------------------------------ writing

    @PluginMethod
    public void beginWrite(PluginCall call) {
        String name = call.getString("name", "PodiumCast_" + System.currentTimeMillis());
        String kind = call.getString("kind", "video");
        String mime = call.getString("mime", "video/webm");
        Integer width = call.getInt("width", 0);
        Integer height = call.getInt("height", 0);
        Long createdAt = call.getLong("createdAt", System.currentTimeMillis());

        io.execute(() -> {
            try {
                Entry entry = new Entry();
                entry.id = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
                entry.dir = "photo".equals(kind) ? "photos" : "videos";
                entry.name = uniqueName(MediaRoot.dir(getContext()), entry.dir, sanitize(name));
                entry.kind = kind;
                entry.mime = mime;
                entry.width = width == null ? 0 : width;
                entry.height = height == null ? 0 : height;
                entry.createdAt = createdAt == null ? System.currentTimeMillis() : createdAt;

                File target = fileFor(entry);
                RandomAccessFile raf = new RandomAccessFile(target, "rw");
                raf.setLength(0);
                writers.put(entry.id, new Writer(raf, entry));

                JSObject out = new JSObject();
                out.put("handle", entry.id);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("无法创建文件：" + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void append(PluginCall call) {
        String handle = call.getString("handle");
        String data = call.getString("data");
        if (handle == null || data == null) { call.reject("缺少 handle 或 data"); return; }
        io.execute(() -> {
            Writer writer = writers.get(handle);
            if (writer == null) { call.reject("未知写入句柄 " + handle); return; }
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                writer.file.seek(writer.bytes);
                writer.file.write(bytes);
                writer.bytes += bytes.length;
                call.resolve();
            } catch (Exception e) {
                call.reject("写入失败：" + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void end(PluginCall call) {
        String handle = call.getString("handle");
        Long durationMs = call.getLong("durationMs", 0L);
        if (handle == null) { call.reject("缺少 handle"); return; }
        io.execute(() -> {
            Writer writer = writers.remove(handle);
            if (writer == null) { call.reject("未知写入句柄 " + handle); return; }
            try {
                writer.file.close();
                writer.entry.durationMs = durationMs == null ? 0 : durationMs;
                List<Entry> index = readIndex();
                index.removeIf(e -> e.id.equals(writer.entry.id));
                index.add(writer.entry);
                writeIndex(index);
                File file = fileFor(writer.entry);
                call.resolve(toJs(writer.entry, file.length()));
            } catch (Exception e) {
                call.reject("收尾失败：" + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void abort(PluginCall call) {
        String handle = call.getString("handle");
        if (handle == null) { call.resolve(); return; }
        io.execute(() -> {
            Writer writer = writers.remove(handle);
            if (writer != null) {
                try { writer.file.close(); } catch (Exception ignored) { }
                //noinspection ResultOfMethodCallIgnored
                fileFor(writer.entry).delete();
            }
            call.resolve();
        });
    }

    // ------------------------------------------------------------------ reading

    @PluginMethod
    public void readRange(PluginCall call) {
        String id = call.getString("id");
        Integer offset = call.getInt("offset", 0);
        Integer length = call.getInt("length", 0);
        if (id == null) { call.reject("缺少 id"); return; }
        io.execute(() -> {
            try {
                Entry entry = findEntry(id);
                if (entry == null) { call.reject("未找到文件 " + id); return; }
                File file = fileFor(entry);
                long start = Math.max(0, Math.min(offset == null ? 0 : offset, file.length()));
                long end = Math.max(start, Math.min(start + (length == null ? 0 : length), file.length()));
                int size = (int) (end - start);
                byte[] buffer = new byte[Math.max(0, size)];
                try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
                    raf.seek(start);
                    raf.readFully(buffer);
                }
                JSObject out = new JSObject();
                out.put("data", Base64.encodeToString(buffer, Base64.NO_WRAP));
                call.resolve(out);
            } catch (Exception e) {
                call.reject("读取失败：" + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.resolve(); return; }
        io.execute(() -> {
            try {
                List<Entry> index = readIndex();
                Entry found = null;
                for (Entry e : index) if (e.id.equals(id) || e.name.equals(id)) { found = e; break; }
                if (found != null) {
                    //noinspection ResultOfMethodCallIgnored
                    fileFor(found).delete();
                    index.remove(found);
                    writeIndex(index);
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("删除失败：" + e.getMessage(), e);
            }
        });
    }

    // ------------------------------------------------------------------ helpers

    private JSObject toJs(Entry entry, long size) {
        JSObject out = new JSObject();
        out.put("id", entry.id);
        out.put("name", entry.name);
        out.put("kind", entry.kind);
        out.put("mime", entry.mime);
        out.put("size", size);
        out.put("width", entry.width);
        out.put("height", entry.height);
        out.put("durationMs", entry.durationMs);
        out.put("createdAt", entry.createdAt);
        out.put("origin", "cast");
        // `localPath` lets the JS layer build a Capacitor.convertFileSrc() URL for playback.
        out.put("localPath", fileFor(entry).getAbsolutePath());
        return out;
    }

    private File fileFor(Entry entry) {
        File dir = "photos".equals(entry.dir) ? MediaRoot.photos(getContext()) : MediaRoot.videos(getContext());
        return new File(dir, entry.name);
    }

    private Entry findEntry(String id) throws Exception {
        for (Entry e : readIndex()) {
            if (e.id.equals(id) || e.name.equals(id)) return e;
        }
        return null;
    }

    private List<Entry> readIndex() throws Exception {
        List<Entry> out = new ArrayList<>();
        File index = MediaRoot.index(getContext());
        if (!index.exists()) return out;
        String text = new String(Files.readAllBytes(index.toPath()), StandardCharsets.UTF_8);
        if (text.trim().isEmpty()) return out;
        JSONArray array = new JSONArray(text);
        for (int i = 0; i < array.length(); i++) {
            JSONObject o = array.optJSONObject(i);
            if (o != null) out.add(Entry.fromJson(o));
        }
        return out;
    }

    private void writeIndex(List<Entry> entries) throws Exception {
        JSONArray array = new JSONArray();
        List<Entry> sorted = new ArrayList<>(entries);
        sorted.sort(Comparator.comparingLong((Entry e) -> e.createdAt).reversed());
        for (Entry e : sorted) array.put(e.toJson());
        File index = MediaRoot.index(getContext());
        Files.write(index.toPath(), array.toString(2).getBytes(StandardCharsets.UTF_8));
    }

    /** Avoids the `_1`, `_2` dance the shared `uniqueName` does on the JS side. */
    private String uniqueName(File base, String dir, String name) {
        List<String> taken = new ArrayList<>();
        File[] files = new File(base, dir).listFiles();
        if (files != null) for (File f : files) taken.add(f.getName());
        if (!taken.contains(name)) return name;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 10000; i++) {
            String candidate = String.format(Locale.US, "%s_%d%s", stem, i, ext);
            if (!taken.contains(candidate)) return candidate;
        }
        return stem + "_" + System.currentTimeMillis() + ext;
    }

    private static String sanitize(String name) {
        String cleaned = name.replaceAll("[\\\\/:*?\"<>|\\u0000-\\u001f]", "_").replaceAll("^\\.+", "").trim();
        return cleaned.isEmpty() ? "PodiumCast_" + System.currentTimeMillis() : cleaned;
    }

    @SuppressWarnings("unused")
    private static List<String> emptyList() { return Collections.emptyList(); }
}
