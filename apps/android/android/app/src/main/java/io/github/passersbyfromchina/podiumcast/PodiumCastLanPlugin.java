package io.github.passersbyfromchina.podiumcast;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONObject;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * PodiumCastLan — the native half of the Android transport.
 *
 * ## Why this plugin has to exist
 *
 * A WebView can open a WebSocket but cannot *listen* on one. PodiumCast's Cast role is always
 * the server (说明\连接方式.xlsx), and on Android the Cast may be the phone in the user's hand,
 * so the listening socket has to live in Java. This plugin owns:
 *
 *   • an embedded WebSocket server (Java-WebSocket) on port 8765,
 *   • UDP discovery — both the beacon a desktop Cast would send and the scan a Stage performs,
 *     since {@code DatagramSocket} is equally out of reach for page JavaScript,
 *   • the local-network facts the UI needs: IPv4 address, display metrics, device name.
 *
 * The JS side never sees a socket. It hands over an already-encoded JPEG (base64) and the
 * plugin fans it out, matching the {@code CastBridge} contract that the desktop main process
 * implements with `ws`.
 *
 * ## Binary payloads
 *
 * Capacitor marshals plugin arguments as JSON, so binary crosses the bridge as base64. That is
 * the one place where the Android path costs more than Electron's structured clone (which
 * passes a Uint8Array through untouched) — see PREVIEW guidance in the UI: the Android default
 * preview size is deliberately lower.
 */
@CapacitorPlugin(
    name = "PodiumCastLan",
    permissions = {
        @Permission(alias = "camera", strings = { android.Manifest.permission.CAMERA }),
        @Permission(alias = "microphone", strings = { android.Manifest.permission.RECORD_AUDIO })
    }
)
public class PodiumCastLanPlugin extends Plugin {

    /** Must match DISCOVERY_MAGIC / DISCOVERY_PORT in packages/core/src/protocol.ts. */
    private static final String DISCOVERY_MAGIC = "PODIUMCAST-DISCOVERY/1";
    private static final int DISCOVERY_PORT = 8766;

    private EmbeddedServer server;
    private DatagramSocket beaconSocket;
    private Thread beaconThread;
    private volatile boolean beaconRunning;
    private WifiManager.MulticastLock multicastLock;

    private final ExecutorService worker = Executors.newCachedThreadPool();
    private final AtomicInteger peerSeq = new AtomicInteger(1);
    private final Map<String, WebSocket> peers = new ConcurrentHashMap<>();
    private final Map<WebSocket, String> peerIds = new ConcurrentHashMap<>();

    @Override
    public void load() {
        // Android filters inbound broadcast traffic unless a multicast lock is held. Without
        // it a Stage on this device would never hear a desktop Cast's beacon.
        try {
            WifiManager wifi = (WifiManager) getContext().getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                multicastLock = wifi.createMulticastLock("podiumcast-discovery");
                multicastLock.setReferenceCounted(false);
                multicastLock.acquire();
            }
        } catch (Exception ignored) {
            // Some devices refuse the lock; discovery then relies on the subnet sweep.
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopServer();
        stopBeacon();
        if (multicastLock != null && multicastLock.isHeld()) {
            try { multicastLock.release(); } catch (Exception ignored) { }
            multicastLock = null;
        }
        worker.shutdownNow();
    }

    // ------------------------------------------------------------------ identity

    @PluginMethod
    public void info(PluginCall call) {
        JSObject out = new JSObject();
        String role = roleFromResources();
        out.put("role", role);
        out.put("deviceName", Build.MODEL == null ? "Android" : Build.MODEL);
        out.put("deviceId", "android-" + Build.MODEL + "-" + Build.ID);
        out.put("arch", archName());
        out.put("appVersion", appVersion());
        out.put("mediaLocation", MediaRoot.dir(getContext()).getAbsolutePath());
        out.put("hasAdb", false); // adb reverse is driven from the desktop side.
        out.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(out);
    }

    @PluginMethod
    public void localIPv4(PluginCall call) {
        JSObject out = new JSObject();
        out.put("address", localAddress());
        JSArray all = new JSArray();
        for (String a : allLocalAddresses()) all.put(a);
        out.put("addresses", all);
        call.resolve(out);
    }

    // ------------------------------------------------------------------ WebSocket server

    @PluginMethod
    public void start(PluginCall call) {
        int port = call.getInt("port", 8765);
        if (server != null) {
            call.resolve(stateJson(port));
            return;
        }
        try {
            server = new EmbeddedServer(new InetSocketAddress(port));
            server.setReuseAddr(true);
            server.start();
            // Java-WebSocket's start() is asynchronous; report liveness optimistically and
            // let onError override it, which is what the UI listens for.
            call.resolve(stateJson(port));
        } catch (Exception e) {
            server = null;
            call.reject("无法监听端口 " + port + "：" + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopServer();
        call.resolve();
    }

    @PluginMethod
    public void broadcast(PluginCall call) {
        String text = call.getString("text");
        String binary = call.getString("binary");
        for (WebSocket socket : peers.values()) {
            if (text != null) socket.send(text);
            else if (binary != null) socket.send(Base64.decode(binary, Base64.DEFAULT));
        }
        call.resolve();
    }

    @PluginMethod
    public void sendTo(PluginCall call) {
        String peerId = call.getString("peerId");
        String text = call.getString("text");
        String binary = call.getString("binary");
        WebSocket socket = peers.get(peerId);
        if (socket == null) { call.resolve(); return; }
        if (text != null) socket.send(text);
        else if (binary != null) socket.send(Base64.decode(binary, Base64.DEFAULT));
        call.resolve();
    }

    @PluginMethod
    public void closePeer(PluginCall call) {
        String peerId = call.getString("peerId");
        WebSocket socket = peers.remove(peerId);
        if (socket != null) {
            peerIds.remove(socket);
            socket.close();
        }
        call.resolve();
    }

    @PluginMethod
    public void peers(PluginCall call) {
        JSArray array = new JSArray();
        for (Map.Entry<String, WebSocket> e : peers.entrySet()) {
            JSObject peer = new JSObject();
            peer.put("id", e.getKey());
            peer.put("address", e.getValue().getRemoteSocketAddress() == null
                    ? "?" : e.getValue().getRemoteSocketAddress().toString().replaceFirst("^/", ""));
            peer.put("connectedAt", System.currentTimeMillis());
            array.put(peer);
        }
        JSObject out = new JSObject();
        out.put("peers", array);
        call.resolve(out);
    }

    // ------------------------------------------------------------------ discovery

    @PluginMethod
    public void startBeacon(PluginCall call) {
        int castPort = call.getInt("castPort", 8765);
        int port = call.getInt("port", DISCOVERY_PORT);
        stopBeacon();
        try {
            beaconSocket = new DatagramSocket();
            beaconSocket.setBroadcast(true);
            beaconSocket.setReuseAddress(true);
            beaconRunning = true;
            beaconThread = new Thread(() -> {
                byte[] payload = beaconPayload(castPort).getBytes(StandardCharsets.UTF_8);
                while (beaconRunning && beaconSocket != null && !beaconSocket.isClosed()) {
                    for (String address : broadcastTargets()) {
                        try {
                            beaconSocket.send(new DatagramPacket(payload, payload.length,
                                    InetAddress.getByName(address), port));
                        } catch (Exception ignored) { }
                    }
                    try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
                }
            }, "podiumcast-beacon");
            beaconThread.setDaemon(true);
            beaconThread.start();
            call.resolve();
        } catch (Exception e) {
            call.reject("无法开启广播：" + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void stopBeacon(PluginCall call) {
        stopBeacon();
        call.resolve();
    }

    /**
     * Finds reachable Casts. Strategy order matches packages/core/src/discovery.ts:
     * loopback first (covers the USB transport after {@code adb reverse}), then UDP beacons,
     * then a sweep of the /24 this device sits on.
     */
    @PluginMethod
    public void discover(PluginCall call) {
        final int port = call.getInt("port", 8765);
        final int timeoutMs = call.getInt("timeoutMs", 3500);
        final boolean sweep = call.getBoolean("sweep", true);
        worker.execute(() -> {
            try {
                JSArray found = new JSArray();
                List<String> seen = new ArrayList<>();

                if (probe("127.0.0.1", port, 400)) {
                    found.put(peerJson("127.0.0.1", port, "本机", "loopback"));
                    seen.add("127.0.0.1:" + port);
                }

                DatagramSocket udp = null;
                try {
                    udp = new DatagramSocket(null);
                    udp.setReuseAddress(true);
                    udp.setBroadcast(true);
                    udp.bind(new InetSocketAddress(DISCOVERY_PORT));
                    udp.setSoTimeout(400);
                    byte[] query = (DISCOVERY_MAGIC + " QUERY").getBytes(StandardCharsets.UTF_8);
                    for (String target : broadcastTargets()) {
                        try {
                            udp.send(new DatagramPacket(query, query.length, InetAddress.getByName(target), DISCOVERY_PORT));
                        } catch (Exception ignored) { }
                    }
                    long deadline = System.currentTimeMillis() + Math.min(timeoutMs, 2500);
                    byte[] buffer = new byte[2048];
                    while (System.currentTimeMillis() < deadline) {
                        DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                        try {
                            udp.receive(packet);
                        } catch (Exception timeout) {
                            continue;
                        }
                        String text = new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8);
                        if (!text.startsWith(DISCOVERY_MAGIC)) continue;
                        try {
                            JSONObject json = new JSONObject(text);
                            int castPort = json.optInt("castPort", port);
                            String host = packet.getAddress().getHostAddress();
                            String key = host + ":" + castPort;
                            if (seen.contains(key)) continue;
                            seen.add(key);
                            found.put(peerJson(host, castPort, json.optString("name", host), "udp"));
                        } catch (Exception ignored) { }
                    }
                } catch (Exception ignored) {
                } finally {
                    if (udp != null) udp.close();
                }

                if (found.length() == 0 && sweep) {
                    String mine = localAddress();
                    if (mine != null && mine.contains(".")) {
                        String prefix = mine.substring(0, mine.lastIndexOf('.'));
                        long deadline = System.currentTimeMillis() + timeoutMs;
                        for (int i = 1; i <= 254 && System.currentTimeMillis() < deadline; i++) {
                            String host = prefix + "." + i;
                            if (host.equals(mine)) continue;
                            if (probe(host, port, 220)) {
                                found.put(peerJson(host, port, host, "sweep"));
                                break;
                            }
                        }
                    }
                }

                JSObject out = new JSObject();
                out.put("peers", found);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("扫描失败：" + e.getMessage(), e);
            }
        });
    }

    // ------------------------------------------------------------------ device facts

    @PluginMethod
    public void display(PluginCall call) {
        JSObject out = new JSObject();
        try {
            WindowManager wm = (WindowManager) getContext().getSystemService(Context.WINDOW_SERVICE);
            DisplayMetrics metrics = new DisplayMetrics();
            if (wm != null && wm.getDefaultDisplay() != null) {
                wm.getDefaultDisplay().getRealMetrics(metrics);
            } else {
                metrics = getContext().getResources().getDisplayMetrics();
            }
            out.put("width", metrics.widthPixels);
            out.put("height", metrics.heightPixels);
            out.put("devicePixelRatio", metrics.density);
            out.put("fps", refreshRate(wm));
            out.put("colorSpace", "srgb");
        } catch (Exception e) {
            out.put("width", 1920);
            out.put("height", 1080);
            out.put("devicePixelRatio", 1);
            out.put("fps", 60);
            out.put("colorSpace", "srgb");
        }
        call.resolve(out);
    }

    @PluginMethod
    public void openMediaFolder(PluginCall call) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(Uri.parse(MediaRoot.dir(getContext()).getAbsolutePath()), "resource/folder");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            // Most Android builds have no file-manager intent for a raw app-specific path.
            call.reject("本机没有可打开该目录的文件管理器：" + MediaRoot.dir(getContext()).getAbsolutePath());
        }
    }

    @PluginMethod
    public void usbBridge(PluginCall call) {
        // `adb reverse` is inherently a host-side action; a phone cannot run it against itself.
        JSObject out = new JSObject();
        out.put("ok", false);
        out.put("message", "USB 桥接由拍摄端/电脑执行：在电脑上运行 adb reverse tcp:8765 tcp:8765，然后在本机连接 127.0.0.1:8765。");
        call.resolve(out);
    }

    @PluginMethod
    public void setFullscreen(PluginCall call) {
        // Capacitor's PluginCall.resolve only accepts a JSObject, not a bare boolean. The
        // Android build is always fullscreen (the activity owns the whole screen), so the
        // value is a constant and the JS side only needs the acknowledgement.
        JSObject out = new JSObject();
        out.put("fullscreen", true);
        call.resolve(out);
    }

    @PluginMethod
    public void quit(PluginCall call) {
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().finish());
    }

    // ------------------------------------------------------------------ internals

    private final class EmbeddedServer extends WebSocketServer {
        EmbeddedServer(InetSocketAddress address) { super(address); }

        @Override
        public void onOpen(WebSocket conn, ClientHandshake handshake) {
            String id = "p" + peerSeq.getAndIncrement();
            peers.put(id, conn);
            peerIds.put(conn, id);
            JSObject payload = new JSObject();
            payload.put("id", id);
            payload.put("address", conn.getRemoteSocketAddress() == null
                    ? "?" : conn.getRemoteSocketAddress().toString().replaceFirst("^/", ""));
            payload.put("connectedAt", System.currentTimeMillis());
            notifyListeners("peer", payload);
        }

        @Override
        public void onClose(WebSocket conn, int code, String reason, boolean remote) {
            String id = peerIds.remove(conn);
            if (id != null) peers.remove(id);
            JSObject payload = new JSObject();
            payload.put("id", id == null ? "?" : id);
            payload.put("reason", reason == null || reason.isEmpty() ? ("code " + code) : reason);
            notifyListeners("peerGone", payload);
        }

        @Override
        public void onMessage(WebSocket conn, String message) {
            String id = peerIds.get(conn);
            JSObject payload = new JSObject();
            payload.put("peerId", id == null ? "?" : id);
            payload.put("message", message);
            notifyListeners("text", payload);
        }

        @Override
        public void onMessage(WebSocket conn, ByteBuffer message) {
            byte[] bytes = new byte[message.remaining()];
            message.get(bytes);
            String id = peerIds.get(conn);
            JSObject payload = new JSObject();
            payload.put("peerId", id == null ? "?" : id);
            payload.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            notifyListeners("binary", payload);
        }

        @Override
        public void onError(WebSocket conn, Exception ex) {
            JSObject payload = new JSObject();
            payload.put("message", ex == null ? "unknown" : String.valueOf(ex.getMessage()));
            payload.put("fatal", false);
            notifyListeners("error", payload);
        }

        @Override
        public void onStart() {
            JSObject payload = new JSObject();
            payload.put("port", getPort());
            JSArray addresses = new JSArray();
            for (String a : allLocalAddresses()) addresses.put(a);
            payload.put("addresses", addresses);
            notifyListeners("serverListen", payload);
        }
    }

    private void stopServer() {
        if (server == null) return;
        try { server.stop(600); } catch (Exception ignored) { }
        server = null;
        peers.clear();
        peerIds.clear();
    }

    private void stopBeacon() {
        beaconRunning = false;
        if (beaconSocket != null) {
            try { beaconSocket.close(); } catch (Exception ignored) { }
            beaconSocket = null;
        }
        if (beaconThread != null) {
            beaconThread.interrupt();
            beaconThread = null;
        }
    }

    private JSObject stateJson(int port) {
        JSObject out = new JSObject();
        out.put("port", port);
        JSArray addresses = new JSArray();
        for (String a : allLocalAddresses()) addresses.put(a);
        out.put("addresses", addresses);
        return out;
    }

    private JSObject peerJson(String host, int port, String name, String via) {
        JSObject peer = new JSObject();
        peer.put("address", host + ":" + port);
        peer.put("port", port);
        peer.put("host", host);
        peer.put("name", name);
        peer.put("platform", "android");
        peer.put("via", via);
        return peer;
    }

    private String beaconPayload(int castPort) {
        return String.format(Locale.US,
                "{\"magic\":\"%s\",\"name\":\"%s\",\"deviceId\":\"%s\",\"platform\":\"android\","
                        + "\"castPort\":%d,\"version\":1,\"seq\":%d}",
                DISCOVERY_MAGIC, escape(Build.MODEL), escape(Build.ID), castPort,
                System.currentTimeMillis() / 1000);
    }

    private static String escape(String value) {
        return value == null ? "" : value.replace("\\", "").replace("\"", "");
    }

    /** Every address worth broadcasting to: the /24 broadcast plus the limited broadcast. */
    private List<String> broadcastTargets() {
        List<String> targets = new ArrayList<>();
        for (String address : allLocalAddresses()) {
            int lastDot = address.lastIndexOf('.');
            if (lastDot > 0) targets.add(address.substring(0, lastDot) + ".255");
        }
        targets.add("255.255.255.255");
        return targets;
    }

    private String localAddress() {
        for (String address : allLocalAddresses()) {
            if (address.startsWith("192.168.") || address.startsWith("10.") || address.startsWith("172.")) {
                return address;
            }
        }
        List<String> all = allLocalAddresses();
        return all.isEmpty() ? null : all.get(0);
    }

    private List<String> allLocalAddresses() {
        List<String> out = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            for (NetworkInterface nif : Collections.list(interfaces)) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InetAddress address : Collections.list(nif.getInetAddresses())) {
                    if (address.isLoopbackAddress()) continue;
                    String host = address.getHostAddress();
                    if (host != null && host.indexOf(':') < 0) out.add(host);
                }
            }
        } catch (Exception ignored) { }
        return out;
    }

    /** Cheap TCP reachability probe used by the sweep. */
    private boolean probe(String host, int port, int timeoutMs) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(host, port), timeoutMs);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private int refreshRate(WindowManager wm) {
        try {
            if (wm != null && wm.getDefaultDisplay() != null) {
                float rate = wm.getDefaultDisplay().getRefreshRate();
                if (rate > 1) return Math.round(rate);
            }
        } catch (Exception ignored) { }
        return 60;
    }

    private String roleFromResources() {
        int id = getContext().getResources().getIdentifier("podiumcast_role", "string", getContext().getPackageName());
        if (id != 0) {
            String value = getContext().getString(id);
            if ("stage".equals(value)) return "stage";
        }
        return "cast";
    }

    private String appVersion() {
        try {
            return getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "1.0.0";
        }
    }

    private String archName() {
        if (Build.SUPPORTED_64_BIT_ABIS.length == 0) return "x32";
        String abi = Build.SUPPORTED_64_BIT_ABIS[0];
        if (abi.contains("arm64")) return "arm";
        if (abi.contains("x86_64")) return "x64";
        return "arm";
    }
}
