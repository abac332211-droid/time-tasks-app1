# عقد عملية رصيد المهمة V1

**النطاق:** عقد بيانات واختبارات محضة. لا ينفّذ هذا التغيير ترحيلاً، ولا يعدّل أرصدة المهام، ولا يغيّر مسار Stopwatch أو Pomodoro الحالي.

## لماذا يوجد عقد مستقل؟

يحتاج كل تغيير في رصيد المهمة إلى هوية عملية ثابتة وسلسلة مراجعات قابلة للتحقق. عند إعادة التشغيل يجب التمييز بين ثلاث حالات فقط:

- `not_applied`: المهمة ما زالت على الرصيد والمراجعة ومعرّف العملية السابقين.
- `already_applied`: المهمة تحمل الرصيد المستهدف والمراجعة المستهدفة ومعرّف العملية الحالية معاً.
- `conflict`: أي تركيب آخر؛ لا إصلاح ولا تخمين.

أما `invalid` فيعني أن سجل العملية أو بيانات المهمة نفسها لا تستوفي العقد.

## شكل العملية

```json
{
  "version": 1,
  "operationId": "123e4567-e89b-42d3-a456-426614174000",
  "taskId": 7,
  "kind": "session_credit",
  "sessionId": "123e4567-e89b-42d3-a456-426614174002",
  "previousActualSeconds": null,
  "targetActualSeconds": 90,
  "previousCreditRevision": 0,
  "targetCreditRevision": 1,
  "previousLastCreditOperationId": null,
  "creditedSeconds": 90,
  "creditSource": "measured",
  "createdAt": 1795687200000
}
```

### الحقول والقواعد

- `operationId`: UUID جديد للعملية الواحدة، ويُحفظ في المهمة بوصفه `lastCreditOperationId` عند اعتماد الهدف.
- `taskId`: معرّف مهمة موجب وآمن عددياً.
- `kind`: إما `session_credit` أو `manual_adjustment`.
- `sessionId`: UUID ثابت لهوية مرحلة التركيز في عملية الجلسة؛ لا يحل محل `operationId`.
- `previousActualSeconds` و`targetActualSeconds`: عدد صحيح آمن غير سالب أو `null`.
- `previousCreditRevision` و`targetCreditRevision`: عددان صحيحان آمنان، والهدف يساوي السابق + 1 بالضبط.
- `previousLastCreditOperationId`: UUID العملية السابقة أو `null`، ويجب ألا يساوي هوية العملية الجديدة. إذا كانت المراجعة السابقة صفراً فيلزم أن يكون معرّف العملية السابق `null`؛ وإذا كانت أكبر من صفر فيلزم وجود UUID سابق.
- `createdAt`: طابع إنشاء بالميلي ثانية، ضمن نطاق تاريخ JavaScript الصحيح.

## دلالات الرصيد

### اعتماد جلسة

- `kind = session_credit`.
- `sessionId` مطلوب.
- `creditSource` هو `measured` أو `user_adjusted`.
- `creditedSeconds` عدد صحيح موجب.
- الهدف يساوي `(previousActualSeconds ?? 0) + creditedSeconds`، مع رفض أي تجاوز لـ `Number.MAX_SAFE_INTEGER`.
- جلسة بلا اعتماد (`creditSource = none` أو `creditedSeconds = 0`) لا تنشئ عملية رصيد؛ لكنها لا تُحذف من سجل الجلسات بسبب قصر مدتها.

### تعديل يدوي للرصيد

- `kind = manual_adjustment`.
- `sessionId = null` و`creditSource = user_adjusted` و`creditedSeconds = null`.
- `targetActualSeconds` هو الرصيد المطلق الذي اختاره المستخدم، وقد يكون `null` أو صفراً أو قيمة موجبة.
- يمنع تعديل no-op؛ لا تُستهلك مراجعة جديدة من دون تغير الرصيد.

### الفرق بين null والصفر

`null` يعني أن المهمة لم يُسجّل لها رصيد فعلي. أما `0` فهو رصيد مسجّل يساوي صفراً. لذلك فإن الانتقال من `null` إلى `0` تعديل صريح يرفع `creditRevision` ويأخذ `operationId` جديداً. لا يجوز استخدام `?? 0` عند مقارنة الحالة السابقة أو تصنيف الاسترداد؛ يُستخدم الصفر فقط لحساب هدف اعتماد الجلسة.

## تصنيف الحالة قبل أي استرداد

يجب أن تكون بيانات المهمة مكتملة وصالحة وفق `_validateTaskCreditFields`:

1. تطابق الرصيد السابق والمراجعة السابقة و`previousLastCreditOperationId` يعيد `not_applied`.
2. تطابق الرصيد المستهدف والمراجعة المستهدفة و`operationId` يعيد `already_applied`.
3. أي اختلاف بين هذه الحقول يعيد `conflict` ويمنع الكتابة التلقائية.

التصنيف لا ينفّذ أي كتابة ولا يضيف جلسة ولا يحذف سجلاً.

## حدود هذه الدفعة

أضيفت الدالتان المحضتان `_validateTaskCreditOperationV1` و`_classifyTaskCreditOperationV1` واختباراتهما. لم تُربطا بعد بمسارات الكتابة.

قبل تشغيلهما في الإنتاج، تبقى المتطلبات التالية إلزامية:

- اكتساب Web Lock المشترك ثم إعادة قراءة سجل المهام والمؤقت والجلسات من التخزين داخل القفل.
- كتابة journal دائم `pendingFocusCommit` قبل تغيير الرصيد أو سجل الجلسة.
- استرداد العملية اعتماداً على الحالة السابقة/المستهدفة فقط؛ وأي حالة ثالثة تتوقف للمراجعة.
- عدم إدراج journal المعلّق في نسخ المستخدم الاحتياطية، ومنع الاستيراد أثناء وجوده.
- إبقاء استرداد `pendingStopwatchTransaction` القديم سابقاً لأي ترحيل، مع جسر يحافظ على الرصيد بالثواني والمرايا بالدقائق.
- عدم تفعيل ترحيل `actual` إلى `actualSeconds` في هذه المرحلة.

هذا العقد أساس للاختبارات والتنفيذ المرحلي، وليس إذناً ببدء الترحيل.
