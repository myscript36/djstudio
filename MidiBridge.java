package hu.djstudio.app;

import android.content.Context;
import android.content.pm.PackageManager;
import android.media.midi.MidiDevice;
import android.media.midi.MidiDeviceInfo;
import android.media.midi.MidiManager;
import android.media.midi.MidiOutputPort;
import android.media.midi.MidiReceiver;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import java.util.ArrayList;
import java.util.List;

/**
 * Forwards USB-MIDI messages (e.g. Pioneer DDJ-1000) to the web app: window.MIDI.inject([...]).
 * Android WebView has no Web MIDI, so the native android.media.midi API is used instead.
 */
public class MidiBridge {
    private final Context ctx;
    private final WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<MidiDevice> devices = new ArrayList<>();
    private final List<MidiOutputPort> ports = new ArrayList<>();
    private MidiManager manager;
    private String lastName = null;

    public MidiBridge(Context ctx, WebView web) {
        this.ctx = ctx;
        this.web = web;
    }

    @SuppressWarnings("deprecation")
    public void start() {
        if (!ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_MIDI)) return;
        manager = (MidiManager) ctx.getSystemService(Context.MIDI_SERVICE);
        if (manager == null) return;
        for (MidiDeviceInfo info : manager.getDevices()) open(info);
        manager.registerDeviceCallback(new MidiManager.DeviceCallback() {
            @Override
            public void onDeviceAdded(MidiDeviceInfo info) { open(info); }

            @Override
            public void onDeviceRemoved(MidiDeviceInfo info) {
                lastName = null;
                js("window.MIDI && MIDI.device(null)");
            }
        }, main);
    }

    private void open(final MidiDeviceInfo info) {
        if (info.getOutputPortCount() == 0) return; // we only need ports that send data to us
        manager.openDevice(info, device -> {
            if (device == null) return;
            devices.add(device);
            for (int p = 0; p < info.getOutputPortCount(); p++) {
                MidiOutputPort port = device.openOutputPort(p);
                if (port == null) continue;
                ports.add(port);
                port.connect(new MidiReceiver() {
                    @Override
                    public void onSend(byte[] msg, int offset, int count, long timestamp) {
                        StringBuilder sb = new StringBuilder(32 + count * 4);
                        sb.append("window.MIDI && MIDI.inject([");
                        for (int i = 0; i < count; i++) {
                            if (i > 0) sb.append(',');
                            sb.append(msg[offset + i] & 0xFF);
                        }
                        sb.append("])");
                        js(sb.toString());
                    }
                });
            }
            Bundle props = info.getProperties();
            String name = props.getString(MidiDeviceInfo.PROPERTY_NAME);
            if (name == null) name = props.getString(MidiDeviceInfo.PROPERTY_PRODUCT);
            lastName = name == null ? "MIDI kontroller" : name.replaceAll("[^\\p{L}\\p{N} ._-]", " ");
            announce();
        }, main);
    }

    /** Tell the page which controller is connected (also called after the page has loaded). */
    public void announce() {
        if (lastName != null) js("window.MIDI && MIDI.device('" + lastName + "')");
    }

    private void js(final String code) {
        main.post(() -> web.evaluateJavascript(code, null));
    }

    public void stop() {
        for (MidiOutputPort p : ports) {
            try { p.close(); } catch (Exception ignored) { }
        }
        for (MidiDevice d : devices) {
            try { d.close(); } catch (Exception ignored) { }
        }
        ports.clear();
        devices.clear();
    }
}
