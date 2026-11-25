# السجل الهندسي المنقّح لفحص index.html (v2.9.0)

> هذا السجل يوثّق نتائج مراجعة وثيقة `index (9).html` (v2.9.0)، بعد إعادة التدقيق وحذف التكرار وإعادة معايرة الشدّة. يفصل بين العيوب المؤكدة في الشيفرة والفرضيات التي تحتاج قياسًا أو تشغيلًا على الجهاز المستهدف، ويحدد معيار قبول قابلًا للتحقق لكل بند.

- **إجمالي البنود المستقلة:** 28 عيبًا مؤكدًا في الشيفرة (3 P0، و12 P1، و11 P2، و2 P3)، إضافة إلى 6 بنود تحتاج تحققًا أو قياسًا عمليًا (H-01 إلى H-06).
- **قرار الجاهزية:** غير جاهز للاعتماد النهائي قبل معالجة بنود الموجة 1 واجتياز بروتوكول الاختبار المنقّح.
- **نطاق السجل:** نتائج فحص `index (9).html` (v2.9.0). لا يعني توثيق العيب أنه أُعيد إنتاجه ميدانيًا أو أن إصلاحه نُفّذ.

## القسم أ: العيوب المؤكدة من الشيفرة (Code-Verified Defects)

### أولًا — عيوب حرجة (P0: سلامة البيانات واتساق المعاملات)

#### D-01 [P0] تسمّم خطوط الأساس للتخزين الثانوي بعد resetAll()

- **الموقع:** `resetAll()`, `_recoverInterruptedReset()`, `_trackSecondaryStorageRead()`, `_secondaryStorageWriteAllowed()`.
- **الوصف:** لا تمسح عملية إعادة الضبط `_secondaryStorageBaselines` أو `_secondaryStorageConflicts` أو `_focusTimerExternalConflict` أو `_focusTimerConflictNoticeShown` أو `_invalidFocusSessionsNoticeShown`. ولأن `resetAll()` لا يعيد تحميل الصفحة، تظل المقارنة في `_secondaryStorageWriteAllowed()` مبنية على قيم ما قبل الحذف مقابل null في `localStorage`، فترفض حفظ الخواطر والمشاريع والأفكار والمؤقت في الجلسة نفسها.
- **معيار القبول:** بعد إضافة خاطرة ومشروع وتشغيل المؤقت ثم تنفيذ `resetAll()`، ينجح فورًا (دون إعادة تحميل) إضافة خاطرة جديدة ومشروع جديد وبدء المؤقت وحفظها في `localStorage`.

#### D-02 [P0] تجاوز finishTimer() و _showSessionTransitionDialog() لمعاملة Stopwatch وقفل Web Locks

- **الموقع:** `finishTimer()`, `_applyTimerFinish()`, `_showSessionTransitionDialog()`, مقابل `_showStopwatchSaveDialog()`, `_applyStopwatchSave()`.
- **الوصف:** الحماية عبر `_withStopwatchTransactionLock` و`pendingStopwatchTransaction` و`lastStopwatchTransactionId` محصورة في مسار `resetTimer() ← _showStopwatchSaveDialog()`. أما مسار الإنهاء المعتاد `finishTimer()` (⏹ إنهاء) ومسار تبديل المهام `_showSessionTransitionDialog()` فيعدّلان `task.actual` ويسجلان الجلسة مباشرة دون قفل أو سجل نية دائم أو وسم `transactionId`.
- **معيار القبول:** تمر جميع مسارات حفظ جلسة Stopwatch المرتبطة بمهمة (`resetTimer`, `finishTimer`, `_showSessionTransitionDialog`) عبر معاملة موحّدة محمية بـ`_withStopwatchTransactionLock` و`pendingStopwatchTransaction` و`lastStopwatchTransactionId`.

#### D-03 [P0] سباق الإقلاع غير المتزامن عند استرداد pendingStopwatchTransaction وتضارب النافذتين

- **الموقع:** كتلة التهيئة Init، `_recoverPendingStopwatchSave()`, `_loadFocusTimer()`.
- **الوصف:**
  1. عند الإقلاع بوجود `pendingStopwatchTransaction`، تُجدول `_recoverPendingStopwatchSave()` غير المتزامنة عبر `navigator.locks.request`، بينما تنفذ `_finalizeFocusTimerColdStartRestore()` و`renderAll()` و`_catchUp(true)` تزامنيًا قبلها.
  2. لا تستدعي `_recoverPendingStopwatchSave()` الدالة `renderAll()` عند النجاح، فتبقى الواجهة قديمة.
  3. عند فتح نافذتين معًا، تنجح الأولى وتصفّر المعاملة، بينما تقرأ الثانية `tx` من ذاكرتها القديمة فتصطدم بتغيّر `STORAGE_KEY` وتُفعّل `storageRecoveryRequired = true` كذبًا.
- **معيار القبول:**
  - تقفل واجهة المؤقت أثناء الاسترداد عند الإقلاع وتُحدّث `renderAll()` فور اكتماله.
  - تعيد `_recoverPendingStopwatchSave()` قراءة `FOCUS_TIMER_KEY` داخل القفل؛ فإن أتمّت نافذة أخرى المعاملة، تُحدّث النافذة الثانية `tasks` و`_mainStorageBaselineRaw` و`_secondaryStorageBaselines` و`_sessionsCache` و`renderAll()` وتخرج بلا خطأ ولا قفل.

### ثانيًا — عيوب عالية الأثر (P1: الاسترداد، الزمن، النسخ الاحتياطي، المودالات)

#### D-04 [P1] فشل حفظ الجلسة رقم 501 لغياب تدوير FIFO (FOCUS_MAX_SESSIONS = 500)

- **الموقع:** `_logSession()`, `_saveSessions()`, `_recoverPendingStopwatchSave()`.
- **الوصف:** ترفض `_saveSessions()` أي مصفوفة تتجاوز 500 عنصر، بينما تنفذ `_logSession()` الإدراج (`arr.push(row)`) دون اقتطاع الجلسات الأقدم. عند الجلسة #501: في Pomodoro يتوقف المؤقت وتفشل محاولة التسجيل مع بقاء الحالة؛ وفي مسار استرداد معاملة Stopwatch يفشل `_logSession()` فيرمي استثناءً يفعّل `storageRecoveryRequired = true`.
- **معيار القبول:** عند وجود 500 جلسة ثم تسجيل الجلسة 501 (في Pomodoro وStopwatch)، يُقتطع الأقدم تلقائيًا (يبقى الطول 500) وتُسجَّل الجلسة الجديدة بمعرّف تصاعدي فريد دون تعطيل `storageRecoveryRequired`.

#### D-05 [P1] فشل متزامن مضمون (lock_pending) في _storeRollingRecoveryBackup() وتوست تحذير كاذب

- **الموقع:** `_storeRollingRecoveryBackup()`, `saveData()`, `_completeRollingRecoveryCheckpoint()`.
- **الوصف:** عند توفر `navigator.locks` وكون `_stopwatchTransactionLockDepth === 0`، تضبط `_storeRollingRecoveryBackup()` الحالة `"lock_pending"` وترجع false تزامنيًا، فتلتقط `saveData()` القيمة عبر `_isOptionalRollingRecoveryBackupFailure()` وتطلق توست تحذير على كل عملية حفظ طبيعية، بينما يتأجل الالتقاط الفعلي لوعد غير متزامن قد لا يكتمل قبل إغلاق الصفحة.
- **معيار القبول:** لا يظهر أي توست تحذيري عند جدولة القفل بنجاح في الحفظ الاعتيادي؛ يظهر التنبيه فقط عند فشل حقيقي أو تعذر الكتابة بعد انتظار القفل، مع دمج الطلبات المتلاحقة.

#### D-06 [P1] مصيدة القفل الدائم (storageRecoveryRequired) عند فساد أي مفتاح ثانوي

- **الموقع:** `_loadMentalInbox()`, `_loadThoughts()`, `_loadProjects()`, `_loadSessions()`, `retryStorageRecovery()`.
- **الوصف:** فساد سجل في مفتاح ثانوي يضع `storageRecoveryRequired = true` (أحيانًا بلا تنبيه أثناء `renderAll()`) فيجمد حفظ المهام في `saveData()`. وإذا لم توجد لقطة دوّارة صالحة، تعيد `retryStorageRecovery()` تشغيل `migrateV1ToV2()` على `STORAGE_KEY` السليم أصلًا فتعيد التحميل ثم تعيد قراءة المفتاح الثانوي التالف فتُقفل مجددًا بلا مخرج إلا `resetAll()`.
- **معيار القبول:** عزل خطأ المفاتيح الثانوية عن قفل `STORAGE_KEY` أو توفير مسار استرداد/تنظيف انتقائي للمفتاح التالف (مع الاحتفاظ بنسخة `_corrupt_`) وإشعار تشخيصي صريح باسم المجموعة المتأثرة.

#### D-07 [P1] فجوة زمنية بعد إغلاق _showStopwatchSaveDialog() وقبل حيازة القفل

- **الموقع:** `_showStopwatchSaveDialog()`, `_applyStopwatchSave()`, `_applyStopwatchSaveLocked()`.
- **الوصف:** إغلاق المودال فورًا قبل اكتمال الوعد غير المتزامن لـ`_applyStopwatchSave()` يترك أزرار المؤقت متاحة؛ فإذا بدأ المستخدم جلسة جديدة قبل دخول القفل، تنفذ `_applyStopwatchSaveLocked()` بالزمن القديم ثم تصفّر الجلسة الجديدة.
- **معيار القبول:** تعطيل أزرار المؤقت فور طلب الحفظ حتى حسم الوعد، والتحقق داخل القفل من تطابق `sessionStartAt` وكون `_focusTimer.running === false`.

#### D-08 [P1] غياب سجل معاملة دائم (WAL) في deleteProject() و convertMentalItemToTask() عند قتل العملية

- **الموقع:** `deleteProject()`, `convertMentalItemToTask()`.
- **الوصف:** التراجع التعويضي يحمي من أخطاء `setItem` البرمجية، لكن عند قتل العملية بين الكتابتين: في `deleteProject()` تُفصل `projectId` من كل المهام بينما يبقى المشروع قائمًا (0/0)؛ وفي `convertMentalItemToTask()` تُنشأ المهمة وتبقى الفكرة مفتوحة.
- **معيار القبول:** عكس الترتيب في `deleteProject()` (حفظ `PROJECTS_KEY` أولًا + تنظيف المراجع اليتيمة عند الإقلاع) أو اعتماد سجل معاملة دائم يُستكمل عند الإقلاع للعمليتين.

#### D-09 [P1] خلط زمن التركيز النشط مع مدة التوقف المؤقت (Pause/Resume)

- **الموقع:** `toggleTimer()`, `_catchUp()`, `_logSession()`, `_validateFocusSessionRecord()`.
- **الوصف:**
  1. يفرض `_validateFocusSessionRecord()` أن يكون `|(endMs - startMs) - durationSec * 1000| <= 2000ms` (لا يسمح بفجوة التوقف المؤقت).
  2. في اكتمال Pomodoro عبر `_catchUp()`، يُمرَّر `phaseEndAt` الفعلي إلى `_logSession()`، وعندما يختلف عن `durationSec` بسبب التوقف المؤقت يُرفض، ويُستبدل بـ`sessionStart + durationSec * 1000` مع وسم الجلسة بـ`clockAdjusted: true`.
  3. في مسارات الإنهاء اليدوي التي لا تمرر `endedAtMs`، يولّد `_logSession()` قيمة `endedAt = sessionStart + durationSec * 1000` غير مطابقة لوقت الانتهاء الحقيقي (دون وسم `clockAdjusted`).
- **معيار القبول:** تمثيل مدة التركيز النشطة (`durationSec`) ومدة التوقف المؤقت (`pausedSec` أو فترات التوقف) ووقتي البداية والنهاية الفعليين (`startedAt`, `endedAt`) بصورة مستقلة والتحقق من اتساقها (`endMs - startMs ≈ (durationSec + pausedSec) * 1000`) دون تلويث `endedAt` أو `clockAdjusted`.

#### D-10 [P1] ترتيب تحميل _loadFocusTimer() قبل _loadFocusSettings() وانزياح _catchUp(false)

- **الموقع:** Init، `_loadFocusTimer()`, `_catchUp()`.
- **الوصف:** تُستدعى `_loadFocusTimer()` قبل `_loadFocusSettings()` فتقرأ `_phaseTargetSec()` القيم الافتراضية (25/5/15) بدل المخصصة عند ترميم `pendingPhaseEndedAt` الناقص. وفي `_catchUp(false)` عند تخطي أكثر من مرحلة في دورة واحدة، يُخلط `Date.now()` مع الفائض فينزاح `sessionStartAt` للمرحلة التالية.
- **معيار القبول:** استدعاء `_loadFocusSettings()` قبل `_loadFocusTimer()`، وتمرير `phaseEndAt` المنطقي لكل مرحلة داخل حلقة `_catchUp(false)`.

#### D-11 [P1] سقوط computeRecommendation() إلى تقييم إيجابي رغم انهيار التنفيذ (execution.avg < 3)

- **الموقع:** `computeRecommendation(report)`.
- **الوصف:** إذا كان `wellbeing.avg >= 3` و`execution.avg < 3` و`totalDistractions <= 12` و`gapCount === 0`، يخرج التنفيذ من كتلة `execution.avg < 3` دون `return` ويسقط إما لفرع control أو لرسالة "🟢 المؤشرات في نطاق جيد. استمر.".
- **معيار القبول:** وجود `return` حتمي داخل فرع `execution.avg < 3` يعطي توصية علاجية واضحة مهما كانت قيم المقاطعات أو الفجوة.

#### D-12 [P1] فجوة التحقق في validateBackup() (t.createdAt) وتخطي النسخة الدوّارة بعد إعادة التحميل

- **الموقع:** `validateBackup()`, `showImportPreview()`, `undoLastImport()`, `injectTestData()`, `removeTestData()`.
- **الوصف:** تغفل `validateBackup()` فحص `t.createdAt > 0` الذي تفرضه `validateV2()` فينهار الاستيراد بعد تأكيد المستخدم. كما أن `location.reload()` يُقتل قبل اكتمال الوعد غير المتزامن لـ`_storeRollingRecoveryBackup()`، ثم يتخطى الإقلاع التالي التحديث إذا لم يمضِ 60s على اللقطة القديمة التي تسبق الاستيراد/التعديل.
- **معيار القبول:** مطابقة فحص `t.createdAt` داخل `validateBackup()`، والتحقق من عدم تغيّر `STORAGE_KEY` قبل الاستبدال، وضمان تحديث اللقطة الدوّارة قبل إعادة التحميل أو فرض `minIntervalMs = 0` فورًا بعد إعادة التحميل.

#### D-13 [P1] طمس المودال النشط (#customModalOverlay) عبر التنبيهات غير المتزامنة وتسرب مؤقت SOS

- **الموقع:** `showAlertModal()`, `closeModal()`, `_storeRollingRecoveryBackup()`, `_refreshSecondaryStorageView()`, `startFiveMinTimer()`.
- **الوصف:** نداءات `showAlertModal()` من الوعود أو حدث `storage` تستبدل محتوى `#customModalOverlay` المفتوح حاليًا (مثل قائمة التحقق أو إغلاق اليوم أو معاينة الاستيراد)، ولا توقف `_timerIntervalId` إذا كان مؤقت SOS يعمل.
- **معيار القبول:** إضافة طابور مودالات (`_modalQueue`) يؤجل التنبيهات الجديدة حتى إغلاق المودال النشط، وتصفير `_timerIntervalId` في أي مسار يغلق أو يبدّل المودال.

#### D-14 [P1] السماح باستيراد نسخة V1 أثناء وجود pendingStopwatchTransaction معلّقة

- **الموقع:** `showImportPreview()`, `_restoreFocusTimerSnapshot()`.
- **الوصف:** استيراد نسخة V1 (بدون `focusTimer`) يحافظ على `FOCUS_TIMER_KEY` المحلي؛ فإذا احتوى معاملة معلّقة، يستيقظ الاسترداد بعد إعادة التحميل ويحاول تطبيق دقائق المهمة السابقة على مهام النسخة المستوردة أو يقفل التخزين.
- **معيار القبول:** حظر الاستيراد ما دامت `pendingStopwatchTransaction` موجودة (أسوةً بـ`buildBackupObject()`) وتوجيه المستخدم لإتمام الاسترداد أولًا.

#### D-15 [P1] رفض buildBackupObject() لتصدير النسخة عند وجود عنصر مصلَح في الذاكرة داخل الخواطر/المشاريع

- **الموقع:** `buildBackupObject()`, `_loadThoughts()`, `_loadProjects()`, `validateBackup()`.
- **الوصف:** تقرأ `buildBackupObject()` النص الخام من `localStorage` وتستدعي `validateBackup()`؛ فإذا احتوت `thoughts` أو `projects` سجلًا ينقصه `id` (أصلحته `_loadThoughts/_loadProjects` في الذاكرة فقط)، يرفض التطبيق تصدير كامل النسخة الاحتياطية للمستخدم.
- **معيار القبول:** نجاح تصدير المهام وباقي البيانات السليمة (أو تمرير النسخ المُصلَحة والموثقة) حتى مع وجود عنصر ثانوي تم ترميمه.

### ثالثًا — عيوب متوسطة ومنخفضة الأثر (P2 وP3)

#### D-16 [P2] تعلّق _sendWebNotification() عند غياب تسجيل Service Worker نشط

- **الوصف:** الاعتماد المطلق على `navigator.serviceWorker.ready` يجعل الوعد معلقًا دون رفض إذا لم ينجح تسجيل `sw.js` أصلًا، فتُرجع الدالة true دون الهبوط إلى `new Notification(...)`.
- **الحل المقترح:** فحص `getRegistration()` مع مهلة قصيرة والتأكد من `reg && reg.active` قبل استخدامه.

#### D-17 [P2] قصور persistDailyLog()

- **الوصف:** غياب التحقق بالعودة (read-back) وعدم إرجاع boolean، مما يُخفي فشل حفظ `mentalNext` في `performShutdown()`.

#### D-18 [P2] حافة createdAt خارج نطاق Date في migrateV1ToV2()

- **الوصف:** القيم `> 8.64e15` تنتج `"NaN-NaN-NaN"` في `firstUseDate` فتفشل `validateV2()`، واستخدام `Math.min.apply` يعرض لـ`RangeError` عند المصفوفات الضخمة.

#### D-19 [P2] صمت تعارضات المفاتيح الثانوية عبر النوافذ

- **الوصف:** إبقاء `_secondaryStorageConflicts[key] = true` بعد تحديث العرض في `_refreshSecondaryStorageView()` يؤدي لفشل الحفظ لاحقًا برسالة عامة "⚠️ تعذر الحفظ".

#### D-20 [P2] محاولة _loadFocusTimer() الكتابة عند clockAdjusted مع pendingStopwatchTransaction

- **الوصف:** تُرفض الكتابة عبر `_pendingStopwatchWriteAllowed()` لأن `_stopwatchTransactionLockDepth === 0`.

#### D-21 [P2] حافة تجمد performance.now() دون 120 ثانية في السبات + توقف المؤقت عند مزامنة ساعة الجهاز

- **الوصف:** السبات المتكرر تحت 120 ثانية يُفقد ثواني بصمت، وقفزة `Date.now()` للأمام توقف المؤقت رغم سلامة `performance.now()`.

#### D-22 [P2] حوافّ التحكم الطرفية في المؤقت

1. `finishTimer()` لا يفحص `awaitingConfirmation` خلال نافذة الـ300ms بعد الإقلاع.
2. تضارب قيمة `completed` في `_applyTimerFinish()` (`true`) مقابل `finishTimer()` غير المرتبط (`false`) عند الإيقاف المبكر.
3. إلغاء `_showSessionTransitionDialog()` يشغّل مؤقتًا كان متوقفًا سابقًا.
4. بقاء `clockAdjusted = true` في الواجهة بعد الاستئناف اليدوي بـ`toggleTimer()`.

#### D-23 [P2] هشاشة إدارة سلاسل التكرار

- **الوصف:** حذف الجذر يوقف السلسلة بصمت مع بقاء شارة 🔁 وزر إيقاف معطل في النسخ السابقة؛ وتعديل النسخ المولدة لا يعدّل القالب؛ ومفاتيح `lastRecurringDates` تتراكم نحو سقف الـ500 في `_validateLastRecurringDates()` دون تنظيف السلاسل المنتهية.

#### D-24 [P2] منطق التقدير وحافة الساعات 00:00–03:59

- **الوصف:** `updateEstimatorHint()` تقترح المتوسط المطلق بدل المعامل النسبي (1 + aggGap) من `computeTypeAnalysis()`؛ و`parseTaskDate()` + `renderHomeSchedule()` تصنفان مهام 00:00–03:59 المضافة ليلًا إما متأخرة فورًا أو «قادمة» حسب تاريخ الإدخال الميلادي مقابل `todayStr()`.

#### D-25 [P2] عوائق الويب وAndroid WebView

- **الوصف:** تقييد `accept=".json,application/json"` في الاستيراد قد يحجب اختيار الملف في بعض مديري ملفات أندرويد؛ غياب مودال نسخ احتياطي في `shareWeeklyReport()`؛ تجزئة FNV-1a لمعرّف عددي في `_taskNotificationId()` (الاستخدام المباشر لـ`taskId` يمنع التصادم)؛ واستدعاء `_playBeep()` قبل انتظار `AudioContext.resume()`.

#### D-26 [P2] فجوات إمكانية الوصول وتحسين تباين المؤقت

- **الوصف:** غياب `aria-label` لأزرار التعديل/الحذف في `renderThoughts()` و`renderProjects()`، وغياب `aria-selected/aria-pressed` لتبويبات المؤقت والمفكرة، وغياب تركيز العنصر الأول في عدة مودالات (SOS, Shutdown, finishTimer, runTestsAndShow).
- **ملاحظة التباين:** ألوان `#b45309` (3.28:1) و`#15803d` (3.29:1) و`#2563eb` (3.19:1) على `#151f32` تجتاز حد WCAG AA للنص الكبير 3.0:1 في `.timer-display` لكنها دون 4.5:1 وبهامش أمان ضيق؛ يوصى باستبدالها بـ`--warning-text` و`--success-text` و`--primary-text`.

#### D-27 [P3] شمول المهام الملغاة في updateEstimatorHint() وسقوط أعمدة exportCSV()

- **الوصف:** شمول المهام الملغاة في `updateEstimatorHint()` (خصوصًا عبر `cancelRecurringOccurrence()` التي لا تصفّر `actual`) + سقوط أعمدة الأولوية والتكرار والمشروع وقائمة التحقق من `exportCSV()`.

#### D-28 [P3] عدم تهريب report.error وe.message قبل العرض

- **الوصف:** تغليف `report.error` و`e.message` بـ`escapeHTML` قبل تمريرهما لـ`sanitizeModalHtml()`.

## القسم ب: بنود تحتاج إثباتًا عمليًا أو قياسًا (Hypotheses & Runtime Verification)

لا تُصنَّف هذه البنود كعيوب مثبتة إلا بعد قياسها أو تنفيذها على بيئة التشغيل الفعلية:

### H-01 — اختبارات الترحيل الـ41

التحقق عمليًا من نتيجة `Object.getOwnPropertyDescriptor(window, "localStorage")` في Android WebView المستهدف وChrome؛ إن أعادت `undefined` (كما في WebIDL القياسي)، يُعتمد fallback على `Object.getPrototypeOf(window)` مع `delete window.localStorage` في `finally`.

### H-02 — سلوك إشعارات Android 12–14 في Capacitor

اختبار فعلي على جهاز Android 13/14 للتحقق من: توقيت طلب `POST_NOTIFICATIONS` عند إضافة أول مهمة موقتة، تأثير `sound: null` على صوت القناة في الخلفية، وموثوقية `allowWhileIdle` مع +300ms عند تقييد `SCHEDULE_EXACT_ALARM`.

### H-03 — حدود السعة ونسبة التضخم

قياس الحجم الفعلي بالبايت/المحرّف في `localStorage` لقاعدة بيانات نموذجية مع وجود `MIGRATION_ARCHIVE_KEY` و`PRE_IMPORT_KEY` و`ROLLING_BACKUP_A/B` على الجهاز المستهدف قبل تقرير سياسة تنظيف.

### H-04 — قياس الأداء الفعلي

قياس زمن الإطار (Performance Profiler) مع 1000 مهمة و500 جلسة على الجهاز المستهدف لكل من: دورة الثانية الواحدة في `_renderFocusTimer()`، ودورة الـ60 ثانية في `_storeRollingRecoveryBackupLocked()`، و`renderAll()`.

### H-05 — تكامل الملفات الخارجية

فحص `sw.js` و`manifest.json` الفعليين في المستودع للتأكد من سياسة الكاش وتحديث النسخة والأيقونات (خارج نطاق `index.html`).

### H-06 — إثبات الصمود تحت قتل العملية والتنافس الحقيقي

تنفيذ اختبارات القتل الحقيقي وتنافس النافذتين الموصوفة في القسم د.

## القسم ج: خارطة الإصلاح المرتبة بالأولوية

1. **الموجة 1 (سلامة البيانات والمعاملات):** D-01, D-02, D-03, D-04, D-05, D-06, D-07, D-12, D-14, D-15.
2. **الموجة 2 (الزمن والمنطق والمنصة والمودالات):** D-08, D-09, D-10, D-11, D-13, D-16, H-01, H-02.
3. **الموجة 3 (حوافّ النطاق، الوصول، والقياس الأدائي):** D-17..D-28 + تحسينات الأداء/السعة المبنية على نتائج قياس H-03 وH-04.

## القسم د: بروتوكول التحقق والاختبار المنقّح

### 1. اختبار انقطاع المعاملة المعلّقة (Stopwatch) — الفصل بين مستويين

**المستوى 1 — حقن استثناء برمجي (Exception Injection):**
- يختبر مسار `catch` وكتابة سجل الاسترداد `pendingStopwatchTransaction` عند فشل `localStorage.setItem("timeTasksApp_v1", ...)`.
- **تنبيه:** هذا الاختبار يثبت منطق المعاملة البرمجي فقط، ولا يثبت الصمود أمام قتل العملية لأن كتل `catch/finally` تستمر بالتنفيذ.

**المستوى 2 — محاكاة قتل العملية الفعلي (Simulated / Real Process Kill):**
- في بيئة WebView عبر `chrome://inspect` (أو المتصفح): إدخال حالة انقطاع حقيقية دون تشغيل `catch/finally` عبر كتابة `pendingStopwatchTransaction` ثم قطع السياق فورًا بـ`adb shell am force-stop <package>` (على أندرويد بعد تأكيد كتابة السجل وقبل اكتمال المسح، أو حقن كتابة الحالة المجزأة مباشرةً في مخزن DevTools ثم إغلاق العملية/النافذة فورًا)، ثم إعادة فتح التطبيق.
- **معيار النجاح:** بعد إعادة الفتح، تُحدَّث الواجهة (`renderAll()`) تلقائيًا، وتُضاف الدقائق مرة واحدة فقط، وتُسجل جلسة واحدة بـ`transactionId` مطابق، وتُصفّر `pendingStopwatchTransaction`، ويبقى `storageRecoveryRequired === false`.

### 2. اختبار Web Locks — الفصل بين مستويين

**المستوى 1 — اختبار الانتظار التسلسلي (Lock Queuing):**
- احتجاز القفل `"timeTasksApp-stopwatch-transaction"` من Console لمدة 5 ثوانٍ ومراقبة `navigator.locks.query()` أثناء حفظ Stopwatch للتأكد من بقاء طلب التطبيق في `pending` حتى تحرير القفل.

**المستوى 2 — اختبار التنافس الحقيقي بين نافذتين مستقلتين (True Cross-Context Contention):**
- **تنبيه بيئي:** Chrome على الهاتف وCapacitor APK لا يشتركان في نفس الأصل ولا `localStorage`؛ لذا يُنفَّذ التنافس الحقيقي بين نافذتين مستقلتين إما على خادم محلي/Pages في لسانين من المتصفح نفسه، أو عبر نافذتي/إطاري سياق على نفس أصل WebView في نسخة الاختبار.
- **معيار النجاح:** فتح نافذتين متزامنتين بوجود `pendingStopwatchTransaction` يؤدي إلى استكمال المعاملة مرة واحدة في النافذة الأولى، ومزامنة النافذة الثانية وتحديث واجهتها دون تفعيل `storageRecoveryRequired = true`.

---

## ملاحظة حالة التنفيذ

هذا الملف هو **سجل مراجعة ومواصفات قبول**، وليس إثباتًا على أن العيوب الـ28 ما زالت موجودة في رأس الفرع الحالي أو أنها أُعيد إنتاجها على الجهاز المستهدف. يجب ربط أي قرار إصلاح أو إغلاق بند ببصمة الملف/الالتزام الذي تمت مراجعته، ونتائج الاختبارات ذات الصلة. البنود H-01 إلى H-06 تظل فرضيات/مهام تحقق حتى تقديم قياس أو تشغيل موثق.


---

## ملحق إغلاق D-01 إلى D-04 — 25 نوفمبر 2026

**فرع الإصلاح:** `codex/v2.9.1-stopwatch-integrity-fix`  
**الرأس المرجعي:** `624b98cc392fd7b0e7357e934b9d64c8d4fbb3cd`  
**تشغيلات الفرع وروابط السجلات:** https://github.com/abac332211-droid/time-tasks-app1/actions?query=branch%3Acodex%2Fv2.9.1-stopwatch-integrity-fix

### تحديث معايير القبول

#### D-01 — Reset وخطوط أساس التخزين الثانوي
- أضيف تصفير `_invalidFocusSessionsNoticeShown` وإبطال `_projectsCache` إلى `_resetSecondaryStorageTrackingAfterReset()` بعد نجاح مزامنة خطوط الأساس، ليغطي Reset العادي والاسترداد المنقطع مع إبقاء الحماية عند فشل القراءة.
- Chromium: `D-01 Reset allows same-page thought, project and timer writes without stale baselines`.
- الاسترداد المنقطع: `startup reset recovery waits for the shared lock and makes an older queued backup callback inert` ممتد للتحقق من زوال ذاكرة المشروع والتنبيه القديمين.
- القبول: نجاح الكتابات الثلاث من الصفحة نفسها، تطابق خطوط الأساس مع التخزين، غياب التعارض و`storageRecoveryRequired`، ومسح الحالة القديمة بعد الاسترداد.
- القرار: لا يغلق إلا بعد نجاح اختباري Chromium على SHA النهائي.

#### D-02 — المسارات الفعلية لحفظ Stopwatch
- لم يُعد كتابة `_commitFocusTaskSession()`؛ الاختبارات الجديدة تمر عبر مسارات التطبيق الفعلية.
- اختبارات Chromium:
  - `D-02 resetTimer save dialog commits the linked Stopwatch transaction exactly once`.
  - `D-02 transition commits the old task before starting the next task timer`.
  - `D-02 transition failure does not start the next task or report success`.
- القبول: تحديث المهمة مرة واحدة، جلسة واحدة ومعرّف معاملة مطابق، journal ممسوح وتصفير المؤقت عند النجاح؛ والانتقال لا يبدأ إلا بعد commit. عند فشل الكتابة يبقى journal والجلسة القديمة متوقفة دون نجاح كاذب.
- اختبار `finishTimer()` القائم لم يُكرر.
- القرار: لا يغلق إلا بعد نجاح اختبارات المسارات الثلاثة على SHA النهائي.

#### D-03 — مزامنة نافذتي الاسترداد
- اختبار `D-03.2 two real same-origin tabs wait for Web Locks and the second page synchronizes memory, baselines and UI` يستخدم صفحة ممسكة بالقفل ويثبت وجود طلبي انتظار حقيقيين عبر `navigator.locks.query()` قبل تحرير المالك.
- يفحص النافذة المنتظرة: tasks، `_mainStorageBaselineRaw`، خطوط أساس `FOCUS_TIMER_KEY` و`FOCUS_SESSIONS_KEY` و`PROJECTS_KEY`، `_sessionsCache`، التعارضات، اكتمال التهيئة، واجهة المهمة المستردة، وعدم مضاعفة الدقائق أو الجلسة.
- القرار: لا يغلق إلا بعد نجاح Chromium على SHA النهائي.

#### D-04 — FIFO في Pomodoro عند 500 جلسة
- اختبار Chromium: `D-04 Pomodoro transaction at 500 sessions evicts once and startup retry does not evict another row`.
- يهيّئ 500 سجل Pomodoro صالحًا، ينفذ `finishTimer()` بمعاملة فعلية، يحقن فشل مسح journal بعد تسجيل الجلسة، ثم يعيد تحميل التطبيق للتحقق من الاسترداد.
- القبول: العدد 500، حذف الصف الأقدم وحده، ID الجديد 501 فريدًا، عدم تكرار الجلسة أو دقائق المهمة، وعودة `storageRecoveryRequired` إلى false. يبقى اختبار Stopwatch `Stopwatch recovery at the 500-session limit evicts once and retry does not evict a second row` وحد `_saveSessions()` الصارم دون تغيير.
- القرار: لا يغلق إلا بعد اجتياز Pomodoro وStopwatch على SHA النهائي.

### بوابات CI وربط SHA
- Push PWA وPR PWA يتحققان من SHA المصدر الذي شغّلا عليه الاختبارات بطباعة `Verified source SHA`.
- PR PWA يختبر SHA رأس PR مباشرةً (`pull_request.head.sha`) بدل merge commit افتراضي.
- Android Debug يتحقق من `github.sha` ويشغل regression ثم يبني Debug ويتحقق من Manifest؛ لا يثبت تشغيل WebView على جهاز Android فعلي.
- **روابط التشغيل:** https://github.com/abac332211-droid/time-tasks-app1/actions?query=branch%3Acodex%2Fv2.9.1-stopwatch-integrity-fix
- اختبارات Playwright المتخطاة في Android Debug لا تُحتسب نجاحًا؛ دليل Chromium المرجعي هو PWA، ويذكر تقرير التسليم عدد كل تخطٍ وسببه وروابط سجلات الوظائف.
- لم تتغير `main`، ولم يُدمج PR #10 أو تتغير حالته، ولم يُنشأ Release أو نشر إصدار.

**الحالة عند إنشاء هذا الملحق:** أضيفت التعديلات والاختبارات، والإغلاق الرسمي ينتظر سجلات Actions الناجحة على SHA النهائي.



---

## قرار الإغلاق المثبت لـ D-01 إلى D-04 — 25 نوفمبر 2026

**هذا الملحق يحل محل حالة الانتظار الواردة في ملحق التكليف السابق.** تحقق الإغلاق على رأس موحد:

- الفرع: `codex/v2.9.1-stopwatch-integrity-fix`
- SHA: `0b64faa61787ff996f3ab6bc65a27639ecfd66e1`
- Push PWA [45539949615](https://github.com/abac332211-droid/time-tasks-app1/actions/runs/45539949615): **327 ناجحًا، 0 فشل، 0 تخطٍ**.
- PR PWA [45539958765](https://github.com/abac332211-droid/time-tasks-app1/actions/runs/45539958765): **327 ناجحًا، 0 فشل، 0 تخطٍ**.
- Android Debug [45539949797](https://github.com/abac332211-droid/time-tasks-app1/actions/runs/45539949797): **BUILD SUCCESSFUL**؛ 297 ناجحًا، 0 فشل، 30 تخطٍ من أصل 327. سبب التخطي أن Playwright/Chromium متاح في PWA workflow المخصص فقط؛ لا تُحتسب الاختبارات المتخطاة نجاحًا في Android، لكنها اجتازت في Push PWA وPR PWA.
- فحوص Manifest: `POST_NOTIFICATIONS` و`RECEIVE_BOOT_COMPLETED` و`WAKE_LOCK` اجتازت.
- Artifact Debug: ID `14987724788`، ZIP SHA-256 `a089f9c49f75e234c99f5f0673582ee6bc5183352fa0a9e1939e02bd564f6020`.

### سجل قرار كل بند
| البند | الاختبارات المقبولة على SHA أعلاه | القرار |
|---|---|---|
| D-01 | اختبار الكتابة بعد Reset في الصفحة نفسها، واختبار الاسترداد المنقطع الذي يتحقق من إزالة المشروع/التنبيه القديمين | **مغلق** |
| D-02 | مسار حفظ حوار `resetTimer()`، والانتقال الناجح، وفشل الانتقال دون تشغيل المهمة التالية أو إعلان نجاح | **مغلق** |
| D-03 | D-03.2 بنافذتين Chromium حقيقيتين، وانتظار Web Locks ومزامنة الذاكرة والخطوط والواجهة | **مغلق** |
| D-04 | Pomodoro عند 500 مع فشل مسح journal وإعادة المحاولة، واختبار FIFO المقابل لـStopwatch | **مغلق** |

### نطاق الإغلاق
الإغلاق أعلاه يخص عيوب D-01 إلى D-04 ومعايير قبولها الآلية. لا يعني اعتماد الإصدار أو إتمام اختبارات Android الميدانية (WebView/Force Stop/Doze/الإشعارات بعد الإقلاع)، ولا يُعد موافقة مستقلة أو دمجًا. PR #10 يبقى Draft مفتوحًا وغير مدمج؛ لا تغيير في `main`، ولا Release أو نشر.
