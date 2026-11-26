  assert.equal(app._classifyTaskCreditOperationV1(
    creditTask(90, 1, operationId), sessionCredit({ taskId: 8 })
  ), 'invalid');
  assert.equal(app._classifyTaskCreditOperationV1(
    creditTask(90, 1, null), sessionCredit({ previousActualSeconds: 90, targetActualSeconds: 180,
      creditedSeconds: 90, previousCreditRevision: 1, targetCreditRevision: 2,
      previousLastCreditOperationId: null })
  ), 'invalid');
});