#!/usr/bin/env python3
"""Install the native monotonic stopwatch clock and notification service."""
from __future__ import annotations

import argparse
import re
from pathlib import Path


PLUGIN = "StopwatchClockPlugin"
SERVICE = "StopwatchForegroundService"
RECEIVER = "StopwatchNotificationActionReceiver"


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
import android.app.NotificationManager;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

@CapacitorPlugin(name = "NativeStopwatchClock")
public final class {PLUGIN} extends Plugin {{
    static final String PREFS = "time_tasks_native_stopwatch";
    static final String TITLE_KEY = "notificationTitle";
    static final String TASK_KEY = "notificationTask";
    static final String START_WALL_KEY = "notificationStartWall";
    static final String ACTIVE_SESSION_TOKEN_KEY = "activeSessionToken";
    static final String ANCHOR_ELAPSED_KEY = "anchorElapsedRealtimeMs";
    static final String ANCHOR_BASE_KEY = "anchorBaseMs";
    static final String ANCHOR_BOOT_KEY = "anchorBootCount";
    static final String ACTION_QUEUE_KEY = "notificationActionQueue";
    static final String ACKED_ACTION_IDS_KEY = "handledNotificationActionIds";
    static final int MAX_PENDING_ACTIONS = 20;
    static final int MAX_ACKED_ACTION_IDS = 10;
    static final Object ACTION_LOCK = new Object();

    static boolean isUuidV4(String value) {{
        if (value == null) return false;
        try {{
            UUID uuid = UUID.fromString(value);
            return uuid.version() == 4 && uuid.variant() == 2
                && uuid.toString().equalsIgnoreCase(value);
        }} catch (IllegalArgumentException ignored) {{
            return false;
        }}
    }}

    static int readBootCount(Context context) {{
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return -1;
        try {{
            return Settings.Global.getInt(
                context.getContentResolver(), Settings.Global.BOOT_COUNT
            );
        }} catch (Settings.SettingNotFoundException | RuntimeException ignored) {{
            return -1;
        }}
    }}

    static JSONArray readActionQueue(SharedPreferences prefs) throws JSONException {{
        String raw = prefs.getString(ACTION_QUEUE_KEY, "[]");
        JSONArray queue = raw == null || raw.trim().isEmpty() ? new JSONArray() : new JSONArray(raw);
        if (queue.length() > MAX_PENDING_ACTIONS) throw new JSONException("action queue exceeds limit");
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < queue.length(); i++) {{
            JSONObject item = queue.optJSONObject(i);
            if (item == null || !isUuidV4(item.optString("actionId", null))
                || !isUuidV4(item.optString("sessionToken", null))
                || !("pause".equals(item.optString("action")) || "finish".equals(item.optString("action")))
                || !ids.add(item.optString("actionId"))) {{
                throw new JSONException("invalid notification action queue entry");
            }}
        }}
        return queue;
    }}

    static JSONArray readAckedIds(SharedPreferences prefs) throws JSONException {{
        String raw = prefs.getString(ACKED_ACTION_IDS_KEY, "[]");
        JSONArray ids = raw == null || raw.trim().isEmpty() ? new JSONArray() : new JSONArray(raw);
        if (ids.length() > MAX_ACKED_ACTION_IDS) throw new JSONException("acked action id list exceeds limit");
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < ids.length(); i++) {{
            String id = ids.optString(i, null);
            if (!isUuidV4(id) || !seen.add(id)) throw new JSONException("invalid acknowledged action id");
        }}
        return ids;
    }}

    static boolean contains(JSONArray values, String value) {{
        for (int i = 0; i < values.length(); i++) {{
            if (value.equals(values.optString(i))) return true;
        }}
        return false;
    }}

    @PluginMethod
    public void getClock(PluginCall call) {{
        int bootCount = readBootCount(getContext());
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
        String sessionToken = call.getData().optString("sessionToken", "");
        long anchorElapsed = call.getData().optLong("anchorElapsedRealtimeMs", -1L);
        long anchorBase = call.getData().optLong("anchorBaseMs", -1L);
        int anchorBoot = call.getData().optInt("anchorBootCount", -1);
        if (!isUuidV4(sessionToken) || anchorElapsed < 0L || anchorBase < 0L || anchorBoot < 0) {{
            call.reject("هوية جلسة المؤقت أو مرساة Android غير صالحة");
            return;
        }}
        int currentBoot = readBootCount(getContext());
        if (currentBoot < 0 || currentBoot != anchorBoot) {{
            call.reject("تعذر التحقق من هوية إقلاع Android؛ لم تبدأ الخدمة");
            return;
        }}
        long elapsedMs = Math.max(0L, call.getData().optLong("elapsedMs", 0L));
        long startWall = System.currentTimeMillis() - elapsedMs;
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        synchronized (ACTION_LOCK) {{
            try {{
                JSONArray queue = readActionQueue(prefs);
                if (queue.length() != 0) {{
                    call.reject("هناك إجراءات إشعار غير محسومة؛ يجب معالجتها قبل بدء جلسة جديدة");
                    return;
                }}
                String currentToken = prefs.getString(ACTIVE_SESSION_TOKEN_KEY, null);
                if (currentToken != null && !currentToken.equals(sessionToken)) {{
                    call.reject("توجد خدمة مؤقت مرتبطة بجلسة أخرى");
                    return;
                }}
                boolean committed = prefs.edit()
                    .putString(TITLE_KEY, title)
                    .putString(TASK_KEY, taskName)
                    .putLong(START_WALL_KEY, startWall)
                    .putString(ACTIVE_SESSION_TOKEN_KEY, sessionToken)
                    .putLong(ANCHOR_ELAPSED_KEY, anchorElapsed)
                    .putLong(ANCHOR_BASE_KEY, anchorBase)
                    .putInt(ANCHOR_BOOT_KEY, anchorBoot)
                    .commit();
                if (!committed) {{
                    call.reject("تعذر تثبيت هوية جلسة المؤقت في تخزين Android");
                    return;
                }}
            }} catch (JSONException error) {{
                call.reject("طابور إجراءات الإشعار تالف؛ لم تبدأ جلسة جديدة", error);
                return;
            }}
        }}
        Intent intent = new Intent(getContext(), {SERVICE}.class);
        intent.setAction({SERVICE}.ACTION_START_OR_UPDATE);
        intent.putExtra(TITLE_KEY, title);
        intent.putExtra(TASK_KEY, taskName);
        intent.putExtra(START_WALL_KEY, startWall);
        intent.putExtra(ACTIVE_SESSION_TOKEN_KEY, sessionToken);
        try {{
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {{
                getContext().startForegroundService(intent);
            }} else {{
                getContext().startService(intent);
            }}
            call.resolve();
        }} catch (RuntimeException error) {{
            synchronized (ACTION_LOCK) {{
                SharedPreferences current = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                if (sessionToken.equals(current.getString(ACTIVE_SESSION_TOKEN_KEY, null))) {{
                    current.edit().remove(TITLE_KEY).remove(TASK_KEY).remove(START_WALL_KEY)
                        .remove(ACTIVE_SESSION_TOKEN_KEY).remove(ANCHOR_ELAPSED_KEY)
                        .remove(ANCHOR_BASE_KEY).remove(ANCHOR_BOOT_KEY).commit();
                }}
            }}
            call.reject("تعذر تشغيل خدمة المؤقت الأمامية", error);
        }}
    }}

    @PluginMethod
    public void stopForegroundTimer(PluginCall call) {{
        String sessionToken = call.getData().optString("sessionToken", "");
        if (!isUuidV4(sessionToken)) {{
            call.reject("هوية جلسة المؤقت غير صالحة عند الإيقاف");
            return;
        }}
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        synchronized (ACTION_LOCK) {{
            try {{
                String activeToken = prefs.getString(ACTIVE_SESSION_TOKEN_KEY, null);
                if (!sessionToken.equals(activeToken)) {{
                    JSObject unchanged = new JSObject();
                    unchanged.put("stopped", false);
                    unchanged.put("reason", "session_mismatch");
                    call.resolve(unchanged);
                    return;
                }}
                if (readActionQueue(prefs).length() != 0) {{
                    call.reject("توجد إجراءات إشعار لم تُقر بعد؛ لا يمكن إيقاف الخدمة");
                    return;
                }}
                boolean committed = prefs.edit().remove(TITLE_KEY).remove(TASK_KEY)
                    .remove(START_WALL_KEY).remove(ACTIVE_SESSION_TOKEN_KEY)
                    .remove(ANCHOR_ELAPSED_KEY).remove(ANCHOR_BASE_KEY).remove(ANCHOR_BOOT_KEY)
                    .commit();
                if (!committed) {{
                    call.reject("تعذر حفظ إيقاف خدمة المؤقت");
                    return;
                }}
            }} catch (JSONException error) {{
                call.reject("تعذر التحقق من طابور إجراءات الإشعار؛ لم توقف الخدمة", error);
                return;
            }}
        }}
        boolean stopped = getContext().stopService(new Intent(getContext(), {SERVICE}.class));
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel({SERVICE}.NOTIFICATION_ID);
        JSObject result = new JSObject();
        result.put("stopped", true);
        result.put("serviceWasRunning", stopped);
        call.resolve(result);
    }}

    @PluginMethod
    public void peekNotificationAction(PluginCall call) {{
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        synchronized (ACTION_LOCK) {{
            try {{
                JSONArray queue = readActionQueue(prefs);
                JSObject result = new JSObject();
                if (queue.length() == 0) {{
                    result.put("hasAction", false);
                    call.resolve(result);
                    return;
                }}
                JSONObject item = queue.getJSONObject(0);
                result.put("hasAction", true);
                result.put("actionId", item.optString("actionId"));
                result.put("sessionToken", item.optString("sessionToken"));
                result.put("action", item.optString("action"));
                result.put("elapsedRealtimeMs", item.optLong("elapsedRealtimeMs", -1L));
                result.put("wallTimeMs", item.optLong("wallTimeMs", -1L));
                result.put("bootCount", item.optInt("bootCount", -1));
                result.put("bootCountAvailable", item.optBoolean("bootCountAvailable", false));
                result.put("anchorElapsedRealtimeMs", item.optLong("anchorElapsedRealtimeMs", -1L));
                result.put("anchorBaseMs", item.optLong("anchorBaseMs", -1L));
                result.put("anchorBootCount", item.optInt("anchorBootCount", -1));
                Object elapsed = item.opt("elapsedMs");
                result.put("elapsedMs", elapsed == null || elapsed == JSONObject.NULL ? JSONObject.NULL : elapsed);
                call.resolve(result);
            }} catch (JSONException error) {{
                call.reject("تعذر قراءة طابور إجراءات الإشعار؛ بقي محفوظاً دون تعديل", error);
            }}
        }}
    }}

    @PluginMethod
    public void acknowledgeNotificationAction(PluginCall call) {{
        String actionId = call.getData().optString("actionId", "");
        String sessionToken = call.getData().optString("sessionToken", "");
        boolean stopMatching = call.getData().optBoolean("stopMatchingService", false);
        if (!isUuidV4(actionId) || !isUuidV4(sessionToken)) {{
            call.reject("معرف الإجراء أو الجلسة غير صالح");
            return;
        }}
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean stopService = false;
        synchronized (ACTION_LOCK) {{
            try {{
                JSONArray queue = readActionQueue(prefs);
                JSONArray acked = readAckedIds(prefs);
                boolean alreadyAcked = contains(acked, actionId);
                JSONArray nextQueue = new JSONArray();
                boolean found = false;
                for (int i = 0; i < queue.length(); i++) {{
                    JSONObject item = queue.getJSONObject(i);
                    if (actionId.equals(item.optString("actionId"))) {{
                        if (!sessionToken.equals(item.optString("sessionToken"))) {{
                            call.reject("هوية الجلسة لا تطابق الإجراء؛ لم يُحذف");
                            return;
                        }}
                        found = true;
                    }} else {{
                        nextQueue.put(item);
                    }}
                }}
                if (!found && !alreadyAcked) {{
                    call.reject("الإجراء غير موجود في الطابور ولم يسبق إقراره");
                    return;
                }}
                JSONArray nextAcked = new JSONArray();
                for (int i = 0; i < acked.length(); i++) {{
                    String oldId = acked.optString(i);
                    if (!actionId.equals(oldId)) nextAcked.put(oldId);
                }}
                nextAcked.put(actionId);
                while (nextAcked.length() > MAX_ACKED_ACTION_IDS) {{
                    JSONArray trimmed = new JSONArray();
                    for (int i = nextAcked.length() - MAX_ACKED_ACTION_IDS + 1; i < nextAcked.length(); i++)
                        trimmed.put(nextAcked.opt(i));
                    nextAcked = trimmed;
                }}
                String activeToken = prefs.getString(ACTIVE_SESSION_TOKEN_KEY, null);
                stopService = stopMatching && sessionToken.equals(activeToken)
                    && nextQueue.length() == 0;
                SharedPreferences.Editor editor = prefs.edit()
                    .putString(ACTION_QUEUE_KEY, nextQueue.toString())
                    .putString(ACKED_ACTION_IDS_KEY, nextAcked.toString());
                if (stopService) {{
                    editor.remove(TITLE_KEY).remove(TASK_KEY).remove(START_WALL_KEY)
                        .remove(ACTIVE_SESSION_TOKEN_KEY).remove(ANCHOR_ELAPSED_KEY)
                        .remove(ANCHOR_BASE_KEY).remove(ANCHOR_BOOT_KEY);
                }}
                if (!editor.commit()) {{
                    call.reject("تعذر حفظ ACK؛ بقي الإجراء في طابور Android");
                    return;
                }}
            }} catch (JSONException error) {{
                call.reject("تعذر إقرار الإجراء؛ بقي الطابور دون تغيير", error);
                return;
            }}
        }}
        if (stopService) {{
            getContext().stopService(new Intent(getContext(), {SERVICE}.class));
            NotificationManager manager = getContext().getSystemService(NotificationManager.class);
            if (manager != null) manager.cancel({SERVICE}.NOTIFICATION_ID);
        }}
        JSObject result = new JSObject();
        result.put("acknowledged", true);
        result.put("serviceStopped", stopService);
        call.resolve(result);
    }}
}}
'''


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
import android.net.Uri;
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
        String title = prefs.getString({PLUGIN}.TITLE_KEY, "");
        String task = prefs.getString({PLUGIN}.TASK_KEY, "");
        String token = prefs.getString({PLUGIN}.ACTIVE_SESSION_TOKEN_KEY, null);
        long startWall = prefs.getLong({PLUGIN}.START_WALL_KEY, 0L);
        String requestedToken = intent == null ? token
            : intent.getStringExtra({PLUGIN}.ACTIVE_SESSION_TOKEN_KEY);
        if (token == null || !token.equals(requestedToken) || startWall <= 0L) {{
            stopSelf();
            return START_NOT_STICKY;
        }}
        if (title == null || title.trim().isEmpty()) title = "مؤقت التركيز يعمل";
        if (task == null) task = "";
        Notification notification = buildNotification(title, task, startWall, token);
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

    private PendingIntent contentIntent() {{
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) return null;
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP
            | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 100, launch, flags);
    }}

    private PendingIntent actionIntent(String action, String token, int requestCode) {{
        Intent intent = new Intent(this, StopwatchNotificationActionReceiver.class);
        intent.setAction("{package}.STOPWATCH_NOTIFICATION_" + action.toUpperCase(java.util.Locale.ROOT));
        intent.setData(Uri.parse("timetasks://stopwatch/" + token + "/" + action));
        intent.putExtra("sessionToken", token);
        intent.putExtra("notificationAction", action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(this, requestCode, intent, flags);
    }}

    private Notification buildNotification(String title, String task, long startWall, String token) {{
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
            .setUsesChronometer(true);
        PendingIntent content = contentIntent();
        if (content != null) builder.setContentIntent(content);
        builder.addAction(new Notification.Action.Builder(
            android.R.drawable.ic_media_pause, "إيقاف مؤقت",
            actionIntent("pause", token, 101)).build());
        builder.addAction(new Notification.Action.Builder(
            android.R.drawable.ic_menu_close_clear_cancel, "إنهاء الجلسة",
            actionIntent("finish", token, 102)).build());
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


def _receiver_source(package: str) -> str:
    return f'''package {package};

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class StopwatchNotificationActionReceiver extends BroadcastReceiver {{
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final int MAX_PENDING_ACTIONS = {PLUGIN}.MAX_PENDING_ACTIONS;
    private static final String TAG = "StopwatchAction";

    @Override
    public void onReceive(Context context, Intent intent) {{
        final String action = intent == null ? null : intent.getStringExtra("notificationAction");
        final String sessionToken = intent == null ? null : intent.getStringExtra("sessionToken");
        if (!"pause".equals(action) && !"finish".equals(action)) return;
        if (!{PLUGIN}.isUuidV4(sessionToken)) return;

        // Capture clocks at receiver entry, before executor scheduling or disk I/O.
        final long eventElapsedRealtimeMs = SystemClock.elapsedRealtime();
        final long eventWallTimeMs = System.currentTimeMillis();
        final int eventBootCount = {PLUGIN}.readBootCount(context);
        final PendingResult pending = goAsync();
        final Context appContext = context.getApplicationContext();

        EXECUTOR.execute(() -> {{
            try {{
                SharedPreferences prefs = appContext.getSharedPreferences({PLUGIN}.PREFS, Context.MODE_PRIVATE);
                synchronized ({PLUGIN}.ACTION_LOCK) {{
                    String raw = prefs.getString({PLUGIN}.ACTION_QUEUE_KEY, "[]");
                    JSONArray queue = raw == null || raw.trim().isEmpty() ? new JSONArray() : new JSONArray(raw);
                    if (queue.length() >= MAX_PENDING_ACTIONS) {{
                        Log.e(TAG, "Action queue is full; preserving all pending actions.");
                        return;
                    }}
                    java.util.HashSet<String> knownIds = new java.util.HashSet<>();
                    for (int i = 0; i < queue.length(); i++) {{
                        JSONObject existing = queue.optJSONObject(i);
                        if (existing == null
                            || !{PLUGIN}.isUuidV4(existing.optString("actionId", null))
                            || !{PLUGIN}.isUuidV4(existing.optString("sessionToken", null))
                            || !("pause".equals(existing.optString("action"))
                                || "finish".equals(existing.optString("action")))
                            || !knownIds.add(existing.optString("actionId"))) {{
                            Log.e(TAG, "Corrupt action queue; refusing to replace it.");
                            return;
                        }}
                    }}
                    long anchorElapsed = prefs.getLong({PLUGIN}.ANCHOR_ELAPSED_KEY, -1L);
                    long anchorBase = prefs.getLong({PLUGIN}.ANCHOR_BASE_KEY, -1L);
                    int anchorBoot = prefs.getInt({PLUGIN}.ANCHOR_BOOT_KEY, -1);
                    long eventElapsedMs = -1L;
                    boolean elapsedValid = eventBootCount >= 0 && eventBootCount == anchorBoot
                        && anchorElapsed >= 0L && anchorBase >= 0L
                        && eventElapsedRealtimeMs >= anchorElapsed;
                    if (elapsedValid) {{
                        eventElapsedMs = anchorBase + eventElapsedRealtimeMs - anchorElapsed;
                        elapsedValid = eventElapsedMs >= anchorBase;
                    }}
                    JSONObject entry = new JSONObject();
                    entry.put("actionId", UUID.randomUUID().toString());
                    entry.put("sessionToken", sessionToken);
                    entry.put("action", action);
                    entry.put("elapsedRealtimeMs", eventElapsedRealtimeMs);
                    entry.put("wallTimeMs", eventWallTimeMs);
                    entry.put("bootCount", eventBootCount);
                    entry.put("bootCountAvailable", eventBootCount >= 0);
                    entry.put("anchorElapsedRealtimeMs", anchorElapsed);
                    entry.put("anchorBaseMs", anchorBase);
                    entry.put("anchorBootCount", anchorBoot);
                    entry.put("elapsedMs", elapsedValid ? eventElapsedMs : JSONObject.NULL);
                    JSONArray next = new JSONArray();
                    for (int i = 0; i < queue.length(); i++) next.put(queue.get(i));
                    next.put(entry);
                    if (!prefs.edit().putString({PLUGIN}.ACTION_QUEUE_KEY, next.toString()).commit()) {{
                        Log.e(TAG, "Could not persist notification action; service and notification remain active.");
                    }}
                }}
            }} catch (JSONException | RuntimeException error) {{
                Log.e(TAG, "Could not persist notification action; preserving existing queue.", error);
            }} finally {{
                pending.finish();
            }}
        }});
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
    _write_generated(source_dir / f"{RECEIVER}.java", _receiver_source(package))

    activity_path = source_dir / "MainActivity.java"
    if not activity_path.is_file():
        raise ValueError(f"Generated Capacitor MainActivity is missing: {activity_path}")
    activity = activity_path.read_text(encoding="utf-8")
    package_line = re.search(r"(?m)^package\s+[^;]+;\s*$", activity)
    if not package_line:
        raise ValueError("Could not find the MainActivity package declaration")
    import_lines = [f"import {package}.{PLUGIN};", "import android.content.Intent;"]
    for import_line in import_lines:
        if import_line not in activity:
            package_line = re.search(r"(?m)^package\s+[^;]+;\s*$", activity)
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

    if "onNewIntent(Intent intent)" not in activity:
        last_brace = activity.rfind("}")
        method = (
            "\n    @Override\n"
            "    public void onNewIntent(Intent intent) {\n"
            "        super.onNewIntent(intent);\n"
            "        setIntent(intent);\n"
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
    receiver_name = f'android:name=".{RECEIVER}"'
    if receiver_name not in manifest:
        app_close = manifest.find("</application>")
        if app_close < 0:
            raise ValueError("Could not find the application closing tag")
        receiver = (
            f'    <receiver android:name=".{RECEIVER}" android:enabled="true" '
            'android:exported="false" />\\n'
        )
        manifest = manifest[:app_close] + receiver + manifest[app_close:]

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
