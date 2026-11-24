# 02 — CURRENT STATE

**Project:** TimeTasks  
**Repository:** abac332211-droid/time-tasks-app1  
**Document ID:** 02-CURRENT-STATE  
**Document version:** 1.0  
**Document status:** Draft — Informational Snapshot; Pending Project Owner Approval  
**Observation timestamp:** 2026-11-24 06:31:04 +03:00 (Asia/Aden)  
**Prepared from:** GitHub repository, branches, pull requests, Actions runs, commit comparisons, and rulesets  
**Documentation branch before this file was added:** docs/project-governance  
**Documentation branch starting SHA:** aeeacd4c4fc8648093506101cdc3ebaae2c1a5c8

---

## 1. Purpose and interpretation

This document records an evidence-based snapshot of the repository at the observation timestamp above. It is intended to give project participants a common, dated view of repository structure, branch heads, pull-request states, CI evidence, and outstanding verification gaps.

This is a **point-in-time snapshot**, not a live status feed, not a project policy, and not an authorization to change code, merge pull requests, change versions, create releases, or publish software.

The snapshot becomes stale as soon as any relevant GitHub state changes. Before acting on it, re-read the relevant branch head, pull-request metadata, required checks, review state, rulesets, and latest workflow runs. A later GitHub observation takes precedence over the facts recorded here.

### Reading conventions

- **Observed fact:** Returned directly by GitHub at the observation time.
- **Historical evidence:** Evidence tied to an earlier commit or earlier workflow run; it must not be represented as proof for the current head.
- **Not verified:** No sufficient evidence was obtained in this snapshot.
- **Blocked:** A required verification or governance condition is currently failed, missing, pending, or otherwise not established.

Full 40-character commit SHAs are used wherever a revision is identified. Workflow results are tied to their exact head SHA and run ID.

## 2. Executive snapshot

| Area | Observed state |
|---|---|
| Repository | Public GitHub repository; default branch main |
| main | 0a4dcd13af4fd3bb1779550907234cfc64b05523; branch API reports protected=true |
| Project-governance branch | aeeacd4c4fc8648093506101cdc3ebaae2c1a5c8 before this file was added; protected=false |
| PR #10 | Open, Draft, not merged |
| PR #10 current head | 5d015cea12006244d86755d5ea491d17281c445b |
| PR #10 base ref | codex/v2.9.1-stability |
| Current base-branch tip | 67af8f00a9ada96aaead1597058215a80091310f |
| PR #10 base SHA reported by the PR API | ba14adaaf09474b9d432d31569f5e5067d58193d |
| CI on PR #10 current head | Build APK workflow failed in its pre-build regression-test step; two PWA runs were in progress |
| Physical Android validation | Not verified; no physical-device/WebView evidence was reviewed |
| Independent approval on PR #10 | Not present in the review list inspected |

**Immediate caution:** PR #10's current head has a failed Build APK workflow, and the PR's recorded base SHA is one commit behind the live tip of its base branch. Its PWA verification runs were still running. This snapshot therefore does not establish that PR #10 is ready to merge.

## 3. Repository identity and baseline

- Repository: https://github.com/abac332211-droid/time-tasks-app1
- Default branch: main
- Visibility: public
- Archived: false
- Repository permissions returned for the connected account: admin, maintain, push, pull, and triage.
- Allowed merge methods reported in repository metadata: merge commit, rebase, and squash. The active ruleset for main further limits its permitted merge method; see Section 8.
- Repository metadata reported auto-merge disabled and automatic branch update disabled.

### Default branch baseline

main was observed at:

0a4dcd13af4fd3bb1779550907234cfc64b05523

The project-governance branch was created directly from this main commit. The first governance commit is:

- Commit: aeeacd4c4fc8648093506101cdc3ebaae2c1a5c8
- Parent: 0a4dcd13af4fd3bb1779550907234cfc64b05523
- Tree: 80c596423719aff779fd4b405fa4b18b7a045256
- Message: docs: add TimeTasks project charter v1.1
- Commit time: 2026-11-24 03:19:09 UTC

main was not changed by the governance-document work recorded here.

## 4. Branch inventory

The following 15 branches were returned by the repository branches endpoint. The protection column records the GitHub branch API's protected field; the separate ruleset evidence and its limits are described in Section 8.

| Branch | Observed head SHA | protected |
|---|---|---|
| codex/cleanup-pages-pipeline | 76aea01065676a71baaded90198008bf67fdc68a | false |
| codex/download-bundle-node24 | 7c47527cdfb9aae5e8f46f29e6831099bef9cc2b | false |
| codex/final-audit-fixes | 2c2876333c999b365648a74fc76a8ba5fc804777 | false |
| codex/green-islamic-identity-plan | faf8dbbfaf1191cbd5a9070e5d6c1f0cff7f7040 | false |
| codex/p2-focus-clock-guard | 5c31d729e22c08903f7a9798edd641cafde8917d | false |
| codex/premium-visual-refresh | 61daddbe9aeddc6e1568a504e1f0aa90b88259b2 | false |
| codex/v2.9.0-stability | ea4c53db93b2bedffdad91a70e553c539102c51f | false |
| codex/v2.9.1-release-hardening | 2048ec4825edd2e35d8e7522bebc7f26c9f6f20d | false |
| codex/v2.9.1-stability | 67af8f00a9ada96aaead1597058215a80091310f | false |
| codex/v2.9.1-stopwatch-integrity-fix | 5d015cea12006244d86755d5ea491d17281c445b | false |
| codex/v2.9.1-visual-css-contrast | d8fd91843b0ea5872f8746e3b47de92bdf215ff7 | false |
| docs/integration-review-map-2026-11 | 1b92ce21ca6341b3f25ed74daca8f296edd0fe67 | false |
| docs/project-governance | aeeacd4c4fc8648093506101cdc3ebaae2c1a5c8 | false |
| docs/v2.9.1-release-execution-plan-2026-11-22 | 6aa24a34d886cf9df37b3a765c80318358eae6ef | false |
| main | 0a4dcd13af4fd3bb1779550907234cfc64b05523 | true |

The branch list is the observed inventory returned by GitHub at this time; it is not a guarantee that no branch was created, deleted, or moved immediately afterwards.

## 5. Pull-request inventory

The repository pull-request listing returned the following records:

| PR | State | Draft | Merged | Head branch | Base branch |
|---|---|---:|---:|---|---|
| #10 | open | yes | no | codex/v2.9.1-stopwatch-integrity-fix | codex/v2.9.1-stability |
| #9 | open | yes | no | docs/v2.9.1-release-execution-plan-2026-11-22 | codex/v2.9.1-release-hardening |
| #8 | open | yes | no | docs/integration-review-map-2026-11 | main |
| #7 | open | yes | no | codex/v2.9.1-visual-css-contrast | codex/v2.9.1-stability |
| #6 | open | yes | no | codex/v2.9.1-stability | main |
| #5 | closed | yes | no | codex/v2.9.0-stability | codex/v2.9.1-stability |
| #4 | open | no | no | codex/premium-visual-refresh | main |
| #3 | closed | no | yes | codex/download-bundle-node24 | main |
| #2 | closed | no | yes | codex/cleanup-pages-pipeline | main |
| #1 | closed | no | yes | codex/final-audit-fixes | main |

A PR being open, non-Draft, mergeable, or associated with successful CI does not by itself constitute owner authorization to merge it.

## 6. PR #10 — exact state and base drift

PR #10 is titled **Stopwatch transaction identity and stale backup safeguards**.

- PR URL: https://github.com/abac332211-droid/time-tasks-app1/pull/10
- State: open
- Draft: true
- Merged: false
- Head branch: codex/v2.9.1-stopwatch-integrity-fix
- Current head SHA: 5d015cea12006244d86755d5ea491d17281c445b
- Base branch: codex/v2.9.1-stability
- Base SHA returned in PR metadata: ba14adaaf09474b9d432d31569f5e5067d58193d
- Last PR update returned at observation: 2026-11-24 03:30:16 UTC

### 6.1 Base-branch discrepancy

The live branch inventory reports the current head of codex/v2.9.1-stability as:

67af8f00a9ada96aaead1597058215a80091310f

The PR metadata still reports its base SHA as:

ba14adaaf09474b9d432d31569f5e5067d58193d

A GitHub commit comparison confirms that the live base branch is one commit ahead of the base SHA recorded in PR #10. The additional commit adds:

docs/audits/index-v2.9.0-engineering-audit.md

The comparison between the current PR head branch and the live base branch reports:

- Status: diverged
- PR head ahead by: 67 commits
- PR head behind by: 1 commit

This is material base drift. Before any merge assessment, refresh the PR and base-branch metadata, inspect the current comparison, and ensure the candidate has been tested against the intended base. Do not treat the PR's recorded base SHA and the live branch tip as interchangeable.

### 6.2 Scope observed in the PR

The PR's changed-file listing contains 14 paths:

- .github/workflows/build-apk.yml
- .github/workflows/verify-pwa.yml
- docs/DAILY-PROGRESS.md
- docs/reviews/consolidated-review-ledger-ar.md
- index.html
- package.json
- tests/e2e-startup-lock.spec.js
- tests/focus-session-integrity.test.cjs
- tests/focus-timer-backup.test.cjs
- tests/multi-window-browser.test.cjs
- tests/regression.test.cjs
- tests/startup-stopwatch-recovery.test.cjs
- tests/stopwatch-lifecycle.test.cjs
- tests/stopwatch-transaction-recovery.test.cjs

This list describes the PR diff at the observation point; it does not constitute a code review or approval.

## 7. CI and verification evidence for the current PR #10 head

The following workflow runs were returned for the exact current head SHA:

5d015cea12006244d86755d5ea491d17281c445b

| Workflow | Run ID | Event | State at observation | Result |
|---|---:|---|---|---|
| Build APK | 45319961725 | push | completed | failure |
| Verify PWA and regression cases | 45319961928 | push | in progress | no conclusion yet |
| Verify PWA and regression cases | 45319966283 | pull_request | in progress | no conclusion yet |

Run links:

- Build APK: https://github.com/abac332211-droid/time-tasks-app1/actions/runs/45319961725
- PWA push verification: https://github.com/abac332211-droid/time-tasks-app1/actions/runs/45319961928
- PWA pull-request verification: https://github.com/abac332211-droid/time-tasks-app1/actions/runs/45319966283

### 7.1 Build APK workflow failure

The Build APK workflow did **not** reach APK compilation. Its build job failed in the earlier **Run regression tests** step.

Job ID: 138195853261

The test output recorded:

| Test result | Count |
|---|---:|
| Tests | 293 |
| Passed | 269 |
| Failed | 8 |
| Skipped | 16 |

The eight failing tests reported by the job log were:

1. read-only startup probe finds a pending transaction without writing or migrating
2. startup probe fails closed for an empty-but-present timer record and leaves all bytes untouched
3. sibling transaction outcome is accepted only with both task identity and matching session evidence
4. reset sibling proof requires the complete empty reset footprint and a newer generation
5. all persisted post-recovery initialization remains inside the Stopwatch lock
6. vanished journal without transaction or reset proof keeps recovery locked and does not apply the bundle
7. retryStorageRecovery detects the durable timer journal even when the memory flag is false
8. timer and task write gates remain closed after startup recovery failure

Because the regression step failed, the subsequent Java setup, web-file preparation, dependency installation, Capacitor/Android setup, APK build, Manifest verification, and artifact upload steps were skipped in this run.

**Correct interpretation:** This is a failed pre-build workflow. It is not evidence that an APK was compiled and then failed, and it produced no APK artifact through this run.

### 7.2 PWA verification still running

At the observation timestamp, both PWA workflow runs were still in progress. In the pull-request run, Playwright Chromium installation was in progress and the regression-test step had not yet started. Therefore no PWA test total or pass result can be claimed for this head from these runs.

A later completed run may change the state. Recheck the exact SHA and run IDs before using any later result.

### 7.3 Do not transfer prior-SHA results

Earlier successful workflow runs on earlier revisions are historical evidence only. They do not clear the failures or pending checks reported above for 5d015cea12006244d86755d5ea491d17281c445b.

In particular, a successful workflow on 03b2be40e527a127455894d7dabb847f70d8ab70 or another earlier commit must not be described as a successful verification of the current PR #10 head.

## 8. Reviews, branch rules, and technical enforcement

### 8.1 PR #10 review state

The review listing inspected for PR #10 returned one review with state COMMENTED, submitted on 2026-11-23 13:03:48 UTC.

The review text identifies an earlier reviewed SHA:

1d703d49f615a7c1e5a0e4428d65b3c32325cc80

It explicitly states that an attempted REQUEST_CHANGES review was rejected because the connected identity was the PR author/owner; the submitted record was therefore COMMENTED only. It is not an APPROVED review, not an independent review, and not a formal change-request decision.

The review text raised a P1 concern about possible adoption of a matching legacy focus-session record during pending Stopwatch recovery. Later commits in the PR history have messages addressing legacy-session adoption and lock-release coverage, but this snapshot does not establish an independent review of the current head or independently prove that all prior review concerns are resolved.

No APPROVED review tied to the current head SHA was present in the review list inspected.

### 8.2 Repository ruleset

The repository rulesets endpoint returned one active ruleset:

- Name: Protect-main.
- Ruleset ID: 27728312.
- Target: branch.
- Enforcement: active.
- Ref include: ~DEFAULT_BRANCH.
- Ref exclude: none.

The ruleset therefore targets the repository's default branch, main; it does not include docs/project-governance or the other named working branches.

The returned rules include:

- Restrict branch deletion.
- Restrict non-fast-forward updates.
- Require pull requests.
- Require resolution of review threads.
- Require status checks named build and verify.
- Permit squash as the only merge method under this ruleset.
- Required approving review count: 0.

The required approving review count of zero means this ruleset does not impose a minimum independent approval count. A required pull request and resolved threads must not be confused with a mandatory approval from another reviewer.

The branches endpoint reports main protected=true and docs/project-governance protected=false. The same endpoint reports protected=false for the other listed branches.

The direct branch-protection detail endpoint returned HTTP 403 to the connected integration. Accordingly, this snapshot records the ruleset details that were readable and the branches API's protected flags; it does not claim to have independently inspected every legacy branch-protection setting.

## 9. Project-governance documentation branch

The branch docs/project-governance was observed at:

aeeacd4c4fc8648093506101cdc3ebaae2c1a5c8

It was created from main at:

0a4dcd13af4fd3bb1779550907234cfc64b05523

The branch API reported protected=false. The active repository ruleset inspected above targets only the default branch and does not include this documentation branch.

### 9.1 Existing first document

File: 01-PROJECT-CHARTER.md  
URL: https://github.com/abac332211-droid/time-tasks-app1/blob/docs/project-governance/01-PROJECT-CHARTER.md  
Blob SHA: 414ced0c5f3ce9fc9f39ee354dbd798d0898be01  
Version: 1.1  
Status inside the document: Draft — Pending Project Owner Approval

The Charter is a governance draft. Its presence in GitHub does not mean that the project owner has approved it as final policy.

### 9.2 Current-state branch write boundary

This snapshot is intended to be stored alongside the Charter on docs/project-governance. The documentation work does not authorize changes to main, PR #10, PR #6, any other implementation branch, branch-protection settings, product version, release records, or production deployment.

## 10. Android and field-validation boundary

The evidence described in Section 7 is GitHub Actions evidence. The current Build APK workflow failed before Android setup or APK compilation.

No evidence was reviewed in this snapshot proving that the current PR #10 head was installed and exercised on a physical Android device or on the target Android System WebView.

The following remain distinct and must not be conflated:

- PWA and Playwright/Chromium verification.
- Node.js regression tests.
- Android Debug build and its workflow tests.
- Android WebView runtime behavior.
- Physical Android device field validation.

A successful PWA run does not establish physical Android WebView behavior. A successful Debug build does not establish Doze, Force Stop, process-restart, persistence, or real-device concurrency behavior. Physical-device evidence must identify device model, Android version, WebView version, application/build identity, tested SHA, test steps, actual result, date/time, and supporting evidence.

## 11. Current blockers and unresolved checks

At the observation timestamp, the following items require attention before PR #10 can be considered verified for merge:

1. The Build APK workflow fails at regression testing on the current head; eight tests fail.
2. The two PWA workflow runs for the current head are still in progress; no final result is available in this snapshot.
3. PR #10's recorded base SHA is one commit behind the live tip of its base branch; the changed base must be reconciled and the candidate retested against the intended base.
4. No independent APPROVED review tied to the current head is recorded.
5. Physical Android WebView/device validation is not established by the evidence inspected here.
6. The active main ruleset requires zero approving reviews and does not apply to the project-governance branch.

These are factual observations, not permission for this document's author to modify the application, change branch rules, or alter pull-request state.

## 12. Evidence references

The primary records supporting this snapshot are:

- Repository: https://github.com/abac332211-droid/time-tasks-app1
- Branch inventory API: https://api.github.com/repos/abac332211-droid/time-tasks-app1/branches?per_page=100
- Pull-request inventory API: https://api.github.com/repos/abac332211-droid/time-tasks-app1/pulls?state=all&per_page=100
- PR #10: https://github.com/abac332211-droid/time-tasks-app1/pull/10
- PR #6: https://github.com/abac332211-droid/time-tasks-app1/pull/6
- PR #10 current-head Build APK run: https://github.com/abac332211-droid/time-tasks-app1/actions/runs/45319961725
- PR #10 current-head PWA push run: https://github.com/abac332211-droid/time-tasks-app1/actions/runs/45319961928
- PR #10 current-head PWA pull-request run: https://github.com/abac332211-droid/time-tasks-app1/actions/runs/45319966283
- Active repository ruleset: https://github.com/abac332211-droid/time-tasks-app1/settings/rules/27728312
- Project Charter: https://github.com/abac332211-droid/time-tasks-app1/blob/docs/project-governance/01-PROJECT-CHARTER.md

GitHub API results and workflow output can change or be superseded after the observation timestamp. Links are supplied to make the underlying records independently inspectable.

## 13. Snapshot conclusion

As of 2026-11-24 06:31:04 +03:00, PR #10 remains open and Draft. Its current Build APK workflow is blocked by eight regression-test failures; its two PWA workflows have not yet produced final results; its base branch has advanced beyond the base SHA recorded in the PR; and an independent approval of the current head is not recorded. Physical Android field validation is also not established by the evidence inspected.

The project-governance branch contains the Draft Charter and this dated working snapshot. The branch remains separate from main. No merge, release, version change, branch-protection change, or production action is authorized by this document.

**Operating rule:** Re-observe GitHub before making decisions. Never treat this snapshot, a previous CI result, or a previous review as current approval for a newer SHA.
