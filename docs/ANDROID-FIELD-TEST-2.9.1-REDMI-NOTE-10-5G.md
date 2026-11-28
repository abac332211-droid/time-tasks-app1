# اختبار Android الميداني — PR #10 — Redmi Note 10 5G

## الغرض وحدود الدليل

هذا سجل تنفيذ عملي لبناء Debug الناتج عن رأس PR #10 النهائي. الجهاز المستهدف الذي حدده مالك المشروع هو **Xiaomi Redmi Note 10 5G بنظام Android 13**.

لا تُسجل أي حالة على أنها ناجحة قبل تنفيذها على الهاتف نفسه. نجاح GitHub Actions أو بناء APK لا يثبت وحده أن Android System WebView على الهاتف يوفر Web Locks أو أن دورة Force Stop تعمل كما هو متوقع.

## هوية الجهاز والبناء — تُملأ وقت الاختبار

| الحقل | القيمة |
|---|---|
| الجهاز | Xiaomi Redmi Note 10 5G |
| Android | 13 |
| تاريخ ووقت الاختبار | — |
| Android build / security patch | — |
| WebView provider من `dumpsys webviewupdate` | — |
| WebView version | — |
| PR head SHA | — |
| Android Debug workflow run | — |
| APK artifact ID | — |
| SHA-256 لملف APK الخام بعد فك الأرشيف | — |
| Package ID المتوقع | `com.abac332211.timetasks.debug` |

**شرط هوية البناء:** ثبّت فقط APK من Artifact الذي أُنشئ في تشغيل Android Debug على SHA النهائي نفسه. دوّن بصمة APK الخام بعد تنزيل ZIP وفكّه؛ بصمة ZIP الخاصة بـGitHub ليست بصمة APK الخام.

## التجهيز الآمن

1. استخدم نسخة Debug ذات الحزمة `com.abac332211.timetasks.debug`، فهي منفصلة عن تطبيق الإنتاج.
2. احتفظ بنسخة احتياطية من أي بيانات تريد الحفاظ عليها. سيناريو Reset في هذا الدليل ينفذ على تطبيق Debug وببيانات اختبار فقط.
3. ثبّت APK الناتج من تشغيل SHA النهائي، وافتح التطبيق مرة واحدة حتى يكتمل التهيئة.
4. فعّل USB debugging ووصل الهاتف بحاسوب عليه Android Platform Tools، عند توفره.

أوامر تعريف الجهاز:

```sh
adb devices
adb shell getprop ro.product.model
adb shell getprop ro.build.version.release
adb shell getprop ro.build.version.sdk
adb shell dumpsys webviewupdate
```

يُسجل مزود WebView وإصداره كما يظهران على الجهاز؛ لا تستنتج الإصدار من إصدار Android.

## اختبار Web Locks داخل WebView

1. افتح التطبيق على الهاتف.
2. من Chrome على الحاسوب افتح `chrome://inspect/#devices` واختر WebView الخاص بتطبيق Debug عند ظهوره. إذا لم يظهر، سجّل ذلك ولا تعتبر الاختبار ناجحًا.
3. في Console نفّذ:

```js
({
  origin: location.origin,
  secureContext: window.isSecureContext,
  userAgent: navigator.userAgent,
  locksType: typeof navigator.locks,
  requestType: typeof navigator.locks?.request,
  queryType: typeof navigator.locks?.query
})
```

المتوقع: سياق آمن، ووجود `navigator.locks`، وأن تكون `requestType` هي `function`.

4. اختبر الحصول الفعلي على قفل حصري:

```js
await navigator.locks.request(
  'timetasks-field-verification',
  { mode: 'exclusive' },
  async lock => ({ acquired: true, name: lock.name })
)
```

المتوقع: `acquired: true` دون استثناء. سجّل الناتج و`origin` و`userAgent`. لا تكتفِ بوجود اسم API فقط.

## اختبار Stopwatch المرتبط بمهمة

1. أنشئ مهمة اختبار جديدة وسجّل قيمة الإنجاز الحالية.
2. اربط Stopwatch بالمهمة، ابدأه، أوقفه مؤقتًا، ثم استأنفه وأنهِ الجلسة من مسار الحفظ المعتاد.
3. سجّل قيمة الإنجاز قبل العملية وبعدها، وتحقق من وجود جلسة واحدة فقط لهذه العملية.
4. في WebView Console افحص حالة التخزين (لا تنشر محتوى بيانات شخصية؛ استخدم مهمة الاختبار فقط):

```js
(() => {
  const main = JSON.parse(localStorage.getItem('timeTasksApp_v1') || '{}');
  const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer') || 'null');
  const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
  const task = main.tasks?.find(item => item.name === 'FIELD TEST STOPWATCH');
  const rows = task ? sessions.filter(item => item.taskId === task.id) : [];
  return {
    taskId: task?.id ?? null,
    actual: task?.actual ?? null,
    lastStopwatchTransactionId: task?.lastStopwatchTransactionId ?? null,
    sessions: rows.map(item => ({
      id: item.id,
      durationSec: item.durationSec,
      transactionId: item.transactionId
    })),
    pendingStopwatchTransaction: timer?.pendingStopwatchTransaction ?? null
  };
})()
```

معايير النجاح:
- قيمة الإنجاز تزيد مرة واحدة فقط بالقيمة المتوقعة.
- صف الجلسة واحد فقط للعملية، ويحمل `transactionId`.
- `lastStopwatchTransactionId` للمهمة يطابق `transactionId` للجلسة.
- `pendingStopwatchTransaction` يصبح `null` بعد إكمال الحفظ.
- لا تتكرر الدقائق أو الجلسة بعد إعادة فتح التطبيق.

## اختبار Reset بعد عملية Stopwatch

1. صدّر بيانات الاختبار فقط عند الحاجة.
2. نفّذ Reset من داخل تطبيق Debug.
3. بعد اكتمال Reset أنشئ مهمة اختبار ومشروعًا/خاطرة تجريبية جديدة، وابدأ المؤقت.
4. أعد تحميل التطبيق وتأكد أن الكتابة الجديدة ظاهرة ولا توجد رسالة تعارض أو حاجز استرداد عالق.
5. لا تنفذ Reset في نسخة الإنتاج أو في بيانات شخصية يراد الاحتفاظ بها.

معايير النجاح: لا تُستعاد سجلات الاختبار القديمة بعد Reset، وتُحفظ الكتابات الجديدة ويظل المؤقت قابلًا للاستخدام.

## اختبار Force Stop وإعادة الفتح

1. بعد إكمال جلسة Stopwatch والتحقق من التخزين، افتح إعدادات Android > التطبيقات > TimeTasks Debug.
2. اختر **فرض الإيقاف (Force stop)**.
3. افتح التطبيق من جديد.
4. أعد تشغيل فحص التخزين السابق.

معايير النجاح: لا تتضاعف قيمة الإنجاز، ولا يتكرر سجل الجلسة، ولا يبقى Journal مكتمل معلقًا بعد نجاح الاسترداد.

**حد هذا الاختبار:** Force Stop بعد اكتمال المعاملة يختبر الاستمرارية بعد الإغلاق القسري، لكنه لا يثبت وحده إيقاف العملية في منتصف كتابة المعاملة. لا تدّعِ اختبار الانقطاع في منتصف المعاملة إلا إذا تم توثيق طريقة إعادة إنتاجه على الجهاز.

## اختبار الخلفية / Doze

1. ضع تطبيق Debug في الخلفية والشاشة مطفأة، واترك الهاتف يدخل وضع الخمول حسب إعدادات البطارية المعتادة.
2. أعد فتح التطبيق وتحقق من حالة Stopwatch وقيمة المهمة وسجل الجلسات.
3. إذا استُخدم `adb shell dumpsys deviceidle force-idle`، سجّل الأمر ووقت تنفيذه، ثم نفّذ `adb shell dumpsys deviceidle unforce` بعد الاختبار.

لا تُعمم نتيجة هذا الاختبار على جميع أوضاع توفير الطاقة أو جميع أجهزة Android.

## سجل النتائج

| الاختبار | النتيجة (PASS/FAIL/BLOCKED) | الملاحظات / دليل مختصر |
|---|---|---|
| هوية APK تطابق SHA النهائي | — | — |
| مزود WebView وإصداره | — | — |
| `isSecureContext` | — | — |
| `navigator.locks.request` موجود | — | — |
| الحصول الفعلي على Web Lock | — | — |
| Stopwatch مهمة: تحديث واحد وجلسة واحدة | — | — |
| تطابق transaction IDs | — | — |
| Reset ثم كتابة جديدة | — | — |
| Force Stop ثم إعادة الفتح دون تكرار | — | — |
| الخلفية / Doze | — | — |

## قرار الاختبار

- الحالة عند إنشاء هذا الدليل: **لم يُنفذ على الجهاز بعد**.
- لا تُسجل موافقة ميدانية أو إغلاق بوابة Android حتى تملأ هوية APK ونتائج الاختبارات وتُرفق الأدلة.
- هذا الدليل لا يستبدل مراجعة الكود المستقلة على PR #10.
