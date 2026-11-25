#!/usr/bin/env python3
"""Install the native monotonic stopwatch clock and notification service."""
from __future__ import annotations

import argparse
import re
from pathlib import Path


PLUGIN = "StopwatchClockPlugin"
SERVICE = "StopwatchForegroundService"


def _write_generated(path: Path, source: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_text(encoding="utf-8") == source:
            return
        raise ValueError(f"Refusing to overwrite non-identical custom source: {path}")
    path.write_text(source, encoding="utf-8")


def _plugin_source(package: str) -> str:
    return f'''package {package};

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeStopwatchClock")
public final class {PLUGIN} extends Plugin {{
    static final String PREFS = "time_tasks_native_stopwatch";
    static final String ACTION_EXTRA = "timeTasksNotificationAction";
    static final String TITLE_KEY = "notificationTitle";
    static final String TASK_KEY = "notificationTask";
    static final String START_WALL_KEY = "notificationStartWall";

    @PluginMethod
    public void getClock(PluginCall call) {{
        int bootCount = -1;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {{
            try {{
                bootCount = Settings.Global.getInt(
                    getContext().getContentResolver(), Settings.Global.BOOT_COUNT
                );
            }} catch (Settings.SettingNotFoundException | RuntimeException ignored) {{
                bootCount = -1;
            }}
        }}
        JSObject result = new JSObject();
        result.put("elapsedRealtimeMs", SystemClock.elapsedRealtime());
        result.put("wallTimeMs", System.currentTimeMillis());
        result.put("bootCount", bootCount);
        result.put("bootCountAvailable", bootCount >= 0);
        call.resolve(result);
    }}

    @PluginMethod
    public void startForegroundTimer(PluginCall call) {{
        String title = call.getData().optString("title", "مؤقت التركيز يعمل");
        String taskName = call.getData().optString("taskName", "");
        long elapsedMs = Math.max(0L, call.getData().optLong("elapsedMs", 0L));
        long startWall = System.currentTimeMillis() - elapsedMs;

        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs.edit().putString(TITLE_KEY, title).putString(TASK_KEY, taskName)
            .putLong(START_WALL_KEY, startWall).apply();

        Intent intent = new Intent(getContext(), {SERVICE}.class);
        intent.setAction({SERVICE}.ACTION_START_OR_UPDATE);
        intent.putExtra(TITLE_KEY, title);
        intent.putExtra(TASK_KEY, taskName);
        intent.putExtra(START_WALL_KEY, startWall);
        try {{
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {{
                getContext().startForegroundService(intent);
            }} else {{
                getContext().startService(intent);
            }}
            call.resolve();
        }} catch (RuntimeException error) {{
            call.reject("تعذر تشغيل إشعار المؤقت في الخلفية", error);
        }}
    }}

    @PluginMethod
    public void stopForegroundTimer(PluginCall call) {{
        try {{
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            prefs.edit().remove(TITLE_KEY).remove(TASK_KEY).remove(START_WALL_KEY).apply();
            getContext().stopService(new Intent(getContext(), {SERVICE}.class));
            call.resolve();
        }} catch (RuntimeException error) {{
            call.reject("تعذر إيقاف إشعار المؤقت", error);
        }}
    }}

    @PluginMethod
    public void consumeNotificationAction(PluginCall call) {{
        String action = "";
        Intent current = getActivity().getIntent();
        if (current != null) {{
            String incoming = current.getStringExtra(ACTION_EXTRA);
            if ("pause".equals(incoming) || "finish".equals(incoming)) action = incoming;
            current.removeExtra(ACTION_EXTRA);
            getActivity().setIntent(current);
        }}
        JSObject result = new JSObject();
        result.put("action", action);
        call.resolve(result);
    }}
}}
'''


def _service_source(package: str) -> str:
    return f'''package {package};

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

public final class {SERVICE} extends Service {{
    static final String ACTION_START_OR_UPDATE = "{package}.STOPWATCH_START_OR_UPDATE";
    static final int NOTIFICATION_ID = 0x5357;
    static final String CHANNEL_ID = "focus_stopwatch_running";

    @Override
    public void onCreate() {{
        super.onCreate();
        createNotificationChannel();
    }}

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {{
        SharedPreferences prefs = getSharedPreferences({PLUGIN}.PREFS, Context.MODE_PRIVATE);
        String title = intent != null && intent.hasExtra({PLUGIN}.TITLE_KEY)
            ? intent.getStringExtra({PLUGIN}.TITLE_KEY)
            : prefs.getString({PLUGIN}.TITLE_KEY, "");
        String task = intent != null && intent.hasExtra({PLUGIN}.TASK_KEY)
            ? intent.getStringExtra({PLUGIN}.TASK_KEY)
            : prefs.getString({PLUGIN}.TASK_KEY, "");
        long startWall = intent != null && intent.hasExtra({PLUGIN}.START_WALL_KEY)
            ? intent.getLongExtra({PLUGIN}.START_WALL_KEY, 0L)
            : prefs.getLong({PLUGIN}.START_WALL_KEY, 0L);

        if (startWall <= 0L) {{
            stopSelf();
            return START_NOT_STICKY;
        }}
        if (title == null || title.trim().isEmpty()) title = "مؤقت التركيز يعمل";
        if (task == null) task = "";

        Notification notification = buildNotification(title, task, startWall);
        if (Build.VERSION.SDK_INT >= 34) {{
            startForeground(NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        }} else {{
            startForeground(NOTIFICATION_ID, notification);
        }}
        return START_STICKY;
    }}

    private void createNotificationChannel() {{
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "مؤقت التركيز", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("إشعار مستمر أثناء تشغيل مؤقت التركيز أو ساعة التوقيت.");
        channel.enableVibration(false);
        channel.setSound(null, null);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }}

    private PendingIntent actionIntent(String action, int requestCode) {{
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) return null;
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP
            | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        launch.putExtra({PLUGIN}.ACTION_EXTRA, action);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, requestCode, launch, pendingFlags);
    }}

    private Notification buildNotification(String title, String task, long startWall) {{
        int icon = getApplicationInfo().icon != 0
            ? getApplicationInfo().icon : android.R.drawable.ic_lock_idle_alarm;
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        builder.setSmallIcon(icon)
            .setContentTitle(title)
            .setContentText(task.trim().isEmpty() ? "الجلسة مستمرة" : "المهمة: " + task)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(true)
            .setWhen(startWall)
            .setUsesChronometer(true)
            .setContentIntent(actionIntent("", 100));

        PendingIntent pause = actionIntent("pause", 101);
        PendingIntent finish = actionIntent("finish", 102);
        if (pause != null) builder.addAction(
            new Notification.Action.Builder(android.R.drawable.ic_media_pause,
                "إيقاف مؤقت", pause).build());
        if (finish != null) builder.addAction(
            new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel,
                "إنهاء الجلسة", finish).build());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {{
            builder.setPriority(Notification.PRIORITY_LOW);
        }}
        return builder.build();
    }}

    @Override
    public void onTaskRemoved(Intent rootIntent) {{
        // A running timer remains user-requested when its Activity leaves Recents.
        super.onTaskRemoved(rootIntent);
    }}

    @Override
    public void onDestroy() {{
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        super.onDestroy();
    }}

    @Override
    public IBinder onBind(Intent intent) {{
        return null;
    }}
}}
'''


def configure(root: Path) -> None:
    gradle_path = root / "android" / "app" / "build.gradle"
    manifest_path = root / "android" / "app" / "src" / "main" / "AndroidManifest.xml"
    if not gradle_path.is_file() or not manifest_path.is_file():
        raise ValueError("Generated Android platform files are missing; add the Capacitor Android platform first.")

    gradle = gradle_path.read_text(encoding="utf-8")
    namespaces = re.findall(r'(?m)^\s*namespace\s+["\']([^"\']+)["\']', gradle)
    if len(namespaces) != 1:
        raise ValueError(f"Expected exactly one Android namespace; found {len(namespaces)}")
    package = namespaces[0]
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+", package):
        raise ValueError(f"Invalid Android namespace: {package!r}")

    source_dir = root / "android" / "app" / "src" / "main" / "java" / Path(*package.split("."))
    _write_generated(source_dir / f"{PLUGIN}.java", _plugin_source(package))
    _write_generated(source_dir / f"{SERVICE}.java", _service_source(package))

    activity_path = source_dir / "MainActivity.java"
    if not activity_path.is_file():
        raise ValueError(f"Generated Capacitor MainActivity is missing: {activity_path}")
    activity = activity_path.read_text(encoding="utf-8")
    package_line = re.search(r"(?m)^package\s+[^;]+;\s*$", activity)
    if not package_line:
        raise ValueError("Could not find the MainActivity package declaration")
    import_line = f"import {package}.{PLUGIN};"
    if import_line not in activity:
        activity = activity[:package_line.end()] + "\n\n" + import_line + activity[package_line.end():]

    registration = f"registerPlugin({PLUGIN}.class);"
    if registration not in activity:
        super_call = re.search(r"(?m)^\s*super\.onCreate\(savedInstanceState\);\s*$", activity)
        if super_call:
            indent = re.match(r"\s*", super_call.group(0)).group(0)
            activity = activity[:super_call.start()] + indent + registration + "\n" + activity[super_call.start():]
        else:
            class_match = re.search(r"\bclass\s+MainActivity\s+extends\s+BridgeActivity\s*\{", activity)
            if not class_match or not activity.rstrip().endswith("}"):
                raise ValueError("Could not safely add plugin registration to MainActivity")
            if "import android.os.Bundle;" not in activity:
                package_line = re.search(r"(?m)^package\s+[^;]+;\s*$", activity)
                activity = activity[:package_line.end()] + "\nimport android.os.Bundle;" + activity[package_line.end():]
            last_brace = activity.rfind("}")
            method = (
                "\n    @Override\n"
                "    public void onCreate(Bundle savedInstanceState) {\n"
                f"        {registration}\n"
                "        super.onCreate(savedInstanceState);\n"
                "    }\n"
            )
            activity = activity[:last_brace] + method + activity[last_brace:]
    activity_path.write_text(activity, encoding="utf-8")

    manifest = manifest_path.read_text(encoding="utf-8")
    manifest_root = re.search(r"<manifest\b[^>]*>", manifest)
    if not manifest_root:
        raise ValueError("Could not find the Android manifest root")
    permissions = [
        "android.permission.FOREGROUND_SERVICE",
        "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
        "android.permission.POST_NOTIFICATIONS",
    ]
    missing = [p for p in permissions if f'android:name="{p}"' not in manifest]
    if missing:
        block = "".join(f'\n    <uses-permission android:name="{p}" />' for p in missing)
        manifest = manifest[:manifest_root.end()] + block + manifest[manifest_root.end():]

    service_name = f'android:name=".{SERVICE}"'
    if service_name not in manifest:
        app_close = manifest.find("</application>")
        if app_close < 0:
            raise ValueError("Could not find the application closing tag")
        service = (
            f'    <service android:name=".{SERVICE}" android:enabled="true" '
            'android:exported="false" android:foregroundServiceType="specialUse">\n'
            '        <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" '
            'android:value="User-started focus and stopwatch timing with an ongoing notification and pause/finish controls." />\n'
            '    </service>\n'
        )
        manifest = manifest[:app_close] + service + manifest[app_close:]
    manifest_path.write_text(manifest, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        configure(args.root.resolve())
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    print("Configured native elapsedRealtime clock and specialUse foreground notification service")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
