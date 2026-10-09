package io.github.passersbyfromchina.podiumcast;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * PodiumCast's single Activity, shared by both flavours.
 *
 * The two native plugins are registered explicitly rather than relying on annotation
 * processing to emit `capacitor.plugins.json`. Explicit registration is deterministic, works
 * identically under `assembleCastRelease` and `assembleStageRelease`, and makes the web
 * layer's dependency on native code obvious to anyone reading the Android side.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PodiumCastLanPlugin.class);
        registerPlugin(PodiumCastStorePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
