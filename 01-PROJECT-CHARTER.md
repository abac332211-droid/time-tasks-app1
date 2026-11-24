# TimeTasks — Project Charter

**File:** `01-PROJECT-CHARTER.md`  
**Project:** TimeTasks  
**Repository:** `abac332211-droid/time-tasks-app1`  
**Document Version:** 1.1  
**Document Status:** Draft — Pending Project Owner Approval  
**Document Type:** Project Governance Charter  

---

## 1. Purpose

This charter establishes the governing principles, engineering standards, authorization boundaries, evidence requirements, and quality expectations for the development and maintenance of TimeTasks.

It is the foundational governance document for the project.

All project conversations, technical decisions, implementation work, reviews, testing activities, and release procedures must remain consistent with this charter.

The purpose is to ensure that every consequential change is:

- Traceable to an identifiable source revision.
- Supported by verifiable technical evidence.
- Reviewed according to its risk and scope.
- Authorized by the project owner where required.
- Reproducible and auditable.

## 2. Project Identity and Objectives

TimeTasks is a software application whose development must prioritize correctness, reliability, data integrity, and predictable behavior.

The engineering objectives are:

1. Preserve user data and prevent corruption or unintended loss.
2. Ensure reliable task, timer, Stopwatch, and Pomodoro behavior.
3. Prevent conflicting or stale writes across application instances.
4. Maintain consistency across supported application environments.
5. Establish meaningful automated and physical-device testing.
6. Maintain traceable engineering decisions and risk records.
7. Prevent unreviewed or unauthorized changes from reaching protected branches or releases.

Correctness and data integrity take precedence over development speed.

## 3. Ownership and Authority

The project owner retains final authority over:

- Project priorities and scope.
- Acceptance of architectural decisions.
- Approval of consequential changes.
- Merge authorization.
- Version changes.
- Release creation.
- Production publication.

The assistant may research, inspect, analyze, propose, implement within explicitly authorized boundaries, and prepare evidence.

The assistant must never interpret a request to investigate, implement, test, or review as automatic permission to merge, release, or publish.

### 3.1 Actions requiring explicit authorization

The following actions require specific owner authorization:

- Modifying tracked files or branches in the GitHub repository, within an explicitly authorized implementation scope.
- Merging a pull request.
- Changing application versions.
- Creating a GitHub Release.
- Publishing or deploying a production build.
- Modifying `main`.
- Changing the state of a Draft pull request.
- Performing other consequential repository operations outside the explicitly authorized scope.

Authorization for one action does not authorize another. The implementation, merge, and release authorizations are separate gates, as defined in Sections 18 and 22.

## 4. Repository and Source of Truth

The official repository is:

`https://github.com/abac332211-droid/time-tasks-app1`

The following sources govern their respective areas:

| Information | Authoritative source |
|---|---|
| Source code and commit history | GitHub repository |
| Branches and pull-request state | GitHub |
| Formal review decisions | GitHub pull-request reviews |
| Automated test and build evidence | GitHub Actions logs and artifacts |
| Physical Android test evidence | Recorded device test reports |
| Architectural decisions | Project decision register |
| Risk tracking | Project risk register |
| Project instructions and working context | ChatGPT Project |

The approved GitHub copy of this Charter governs project policy. The authority and precedence of project documents and working instructions are defined in Section 20.

ChatGPT project files and conversation summaries are reference material. They must not be treated as live repository state.

Whenever current repository status matters, inspect GitHub rather than relying on an earlier conversation or an old project document.

Every status report must identify the revision and observation time to which it applies.

## 5. Branch and Repository Safety

No branch may be modified merely because it is technically accessible.

Before making a repository change:

1. Obtain implementation authorization for the repository, target working branch, starting SHA, permitted scope, and allowed operations.
2. Read the current commit SHA of the target branch.
3. Inspect the relevant repository and pull-request state.
4. Understand the existing changes and their scope.
5. Create a new commit that preserves the branch history.
6. Update the branch using an expected-SHA or equivalent lease check.
7. Stop if the branch has moved unexpectedly and reassess before proceeding.

Never use force push to bypass a branch-history conflict.

Never modify `main` without explicit authorization.

Never merge an existing pull request without specific merge authorization.

Do not create a duplicate pull request for work already represented by an existing pull request.

Branch protection must be inspected rather than assumed. Relevant stability and release branches must be assessed independently of `main`.

## 6. Engineering Change Lifecycle

Every significant change must follow the applicable authorization and verification lifecycle:

`PROPOSED → OWNER_AUTHORIZED (IMPLEMENTATION) → IN_PROGRESS → VERIFIED → INDEPENDENTLY_REVIEWED → OWNER_AUTHORIZED (MERGE) → MERGED → OWNER_AUTHORIZED (RELEASE) → RELEASED`

Not every change requires every gate or results in a merge or release. Any non-applicable gate must be recorded as `NOT APPLICABLE` with a documented reason, in accordance with Section 19. A non-applicable stage must not be represented as passed.

`BLOCKED` is an independent stop state that may apply at any stage. Work must not proceed through a blocked mandatory gate.

The lifecycle states have distinct meanings:

- **PROPOSED:** The change has a documented purpose and scope.
- **OWNER_AUTHORIZED (IMPLEMENTATION):** The owner has authorized the defined implementation scope and permitted repository operations.
- **IN_PROGRESS:** Authorized implementation work is underway.
- **VERIFIED:** The required verification evidence for the declared scope exists.
- **INDEPENDENTLY_REVIEWED:** The formal independent review gate has been satisfied, where required.
- **OWNER_AUTHORIZED (MERGE):** The owner has authorized merging the exact reviewed candidate, where a merge is applicable.
- **MERGED:** The authorized change has been merged.
- **OWNER_AUTHORIZED (RELEASE):** The owner has authorized publication of the exact release candidate, where a release is applicable.
- **RELEASED:** The release has been created and published through the authorized process.
- **NOT APPLICABLE:** A gate does not apply to the change; the reason is documented.
- **BLOCKED:** A required condition is missing, failed, uncertain, or unauthorized.

No applicable mandatory stage may be silently skipped.

A change can be technically verified while remaining blocked from review, merge, or release.

## 7. Scoped Owner Authorization

Every consequential owner authorization must be explicit, action-specific, and bound to the strongest available source identity at the time it is granted.

An implementation authorization is granted before implementation and therefore must not require a future Head SHA that does not yet exist. Its required fields are defined in Sections 18 and 22.

Merge and release authorizations must identify the exact candidate revision and artifact details applicable to those actions.

Authorization applies only to its stated action, scope, revision identity, and limitations. A previous approval must never be carried forward to a newer or materially different candidate without renewed authorization.

## 8. Independent Review

ChatGPT adversarial review is a supplementary engineering check. It is not formal independent approval.

Where a formal independent review is required, it must satisfy all of the following:

1. A GitHub reviewer different from the pull-request author.
2. A submitted GitHub review with state `APPROVED`.
3. A review `commit_id` matching the exact candidate Head SHA.
4. No subsequent unreviewed changes to that candidate.
5. A new qualifying review after any relevant revision change.

`COMMENTED` is not `APPROVED`.

A review by the pull-request author is not independent approval.

If the independent review gate is required and not satisfied, the change must remain blocked from any merge requiring that gate.

## 9. Verification and Evidence

Every verification claim must identify its exact scope.

Required evidence, where applicable:

- Candidate Head SHA.
- Base branch and Base SHA.
- Workflow names and Run IDs.
- Tested commit SHA.
- Whether the workflow tested the actual branch head or a synthetic merge candidate.
- Job-level conclusions.
- Actual test totals.
- Passed, failed, and skipped test counts.
- Reasons for skipped tests.
- Build results.
- Artifact identifiers.
- Artifact checksums and the checksum's precise subject (for example, an archive or the raw APK).

Do not infer test totals from a green workflow summary.

Do not describe a skipped test as passed.

Do not claim that a complete test category passed when only a subset ran.

A successful CI workflow establishes only the results demonstrated by its actual logs and reports.

## 10. Technical Enforcement

ChatGPT instructions are operating policies, not technical security controls.

Where supported and appropriate, enforce repository safety through GitHub Branch Protection or Rulesets.

Inspect the actual configuration of each relevant branch, including stability and release branches. Protection of `main` does not establish protection of another branch.

Protection requirements should include:

- Required independent pull-request reviews.
- Required status checks.
- Restrictions on direct pushes.
- Restrictions on force pushes.
- Restrictions on unauthorized branch deletion.
- Appropriate protection of release and stability branches.

Never claim that a branch is adequately protected without inspecting its actual rules.

## 11. Quality and Testing Principles

Testing must be risk-based and must distinguish between execution environments.

At minimum, distinguish:

- Automated unit and integration tests.
- PWA and real-browser tests.
- Android Debug build and workflow tests.
- Android WebView behavior.
- Physical Android device validation.
- Recovery, concurrency, persistence, and data-integrity scenarios.

Evidence from one environment must not be presented as proof of behavior in another environment.

For example, Chromium/PWA success does not establish physical Android WebView reliability.

Skipped tests must remain visible in the verification record with their reasons and implications.

The required test and review gates must be selected according to the change category and risk, as specified in `04-QUALITY-GATES.md`.

## 12. Android Field Testing

Important physical-device tests must be reproducible.

Each report must record:

- Device manufacturer and model.
- Android version.
- Android System WebView version.
- Application version and build identity.
- Tested SHA or documented build provenance.
- Test case identifier and execution steps.
- Expected result.
- Actual result.
- Logs, screenshots, or other available evidence.
- Tester identity.
- Test date and time.

A statement such as "works on my phone" is not sufficient evidence.

CI success cannot replace physical-device validation where field testing is required by the quality gate matrix.

## 13. Risk and Decision Management

Significant risks must be documented with:

- Unique Risk ID.
- Description.
- Severity.
- Likelihood.
- Impact.
- Mitigation.
- Verification test.
- Residual risk.
- Current status.

Architectural and other significant decisions must record:

- Decision ID and date.
- Context and problem.
- Selected decision.
- Alternatives considered.
- Reasons for selection.
- Consequences and risks.
- Verification evidence.
- Whether the decision supersedes an earlier decision.

Superseded decisions must remain traceable rather than silently disappearing.

## 14. Release Integrity

No version change, release creation, merge, or production publication may occur without the specific owner authorization required for that action.

Before a release candidate can proceed, verify:

- Exact source revision.
- Required independent approval.
- Required CI results.
- Required physical-device tests.
- Build and artifact provenance.
- Artifact checksum.
- Remaining risks and documented exceptions.
- Explicit owner authorization for the intended release action.

Debug builds are not production releases.

A successful build is not, by itself, release approval.

## 15. Project Organization

The ChatGPT Project is:

**TimeTasks — Engineering & Quality Control**

Its six primary conversations are:

| ID | Conversation |
|---|---|
| 00 | Command Center and Current Status |
| 01 | Engineering and Architecture |
| 02 | Development and Implementation |
| 03 | Quality Assurance and Testing |
| 04 | Risk Review and Data Integrity |
| 05 | Android and Field Validation |

The five core reference documents are:

1. `01-PROJECT-CHARTER.md`
2. `02-CURRENT-STATE.md`
3. `03-ARCHITECTURE.md`
4. `04-QUALITY-GATES.md`
5. `05-DECISIONS-RISKS.md`

The repository remains the authoritative location for committed project documentation.

ChatGPT project copies are working references and must be refreshed when their underlying source changes.

## 16. Reporting and Communication

Engineering reports must be direct, evidence-based, and explicit about uncertainty.

Every significant status report should distinguish:

- Confirmed facts.
- Observed evidence.
- Inferences.
- Unverified assumptions.
- Outstanding risks.
- Blocked gates.
- Actions requiring owner authorization.

Never claim that a test, review, build, repository operation, or device validation occurred unless evidence confirms it.

Do not conceal failures or skipped tests behind an overall success label.

## 17. Final Governance Principle

Every significant change must have:

- An identifiable author.
- An exact source revision or, for pre-implementation authorization, an identified starting revision.
- A defined scope.
- Traceable verification evidence.
- A formal review outcome where required.
- Explicit, action-specific authorization for consequential actions.
- A documented final disposition.

No stale approval, old test result, previous conversation, or outdated project file may authorize a newer revision.

**The governing principle of TimeTasks is simple:**

> No consequential change without traceability, no verification claim without evidence, no independent approval without an independent reviewer, and no merge or release without explicit owner authorization tied to the exact revision or artifact.

## 18. Authorization Stages

Owner authorization is action-specific and may occur more than once during a change lifecycle. Implementation, merge, and release permissions are separate authorizations.

Distinguish:

### 18.1 Implementation authorization

Permission to modify an explicitly identified working branch and scope.

Before repository implementation begins, record:

- Repository.
- Target working branch.
- Starting SHA.
- Permitted implementation scope.
- Explicitly permitted operations and limitations.
- Authorization timestamp, including time zone.

The implementation authorization applies to work performed within the approved scope from the identified starting revision. It does not authorize merging, version changes, release creation, or publication.

If the target branch changes unexpectedly, diverges, or the scope or permitted operations need to change, stop and obtain renewed authorization where the original authorization no longer safely covers the work.

### 18.2 Merge authorization

Permission to merge an exact reviewed candidate.

Before merging, record:

- Repository and PR number.
- Exact Head SHA.
- Base branch and exact Base SHA.
- Authorized merge action and merge method.
- Scope and any limitations.
- Authorization timestamp, including time zone.

This authorization applies only to the identified candidate and merge action.

### 18.3 Release authorization

Permission to create and publish an exact release candidate.

Before release, record:

- Repository.
- Version and release identity.
- Exact source SHA.
- Artifact identity and Artifact ID, where available.
- Artifact checksum and the exact file or archive it identifies.
- Intended publication environment or destination.
- Authorized publication action and limitations.
- Authorization timestamp, including time zone.

No authorization may be inferred from a previous authorization for a different action.

## 19. Gate Applicability and Exceptions

Each lifecycle gate and verification requirement must be classified as one of:

- `REQUIRED`
- `PASSED`
- `BLOCKED`
- `NOT APPLICABLE`

`NOT APPLICABLE` requires a documented reason and must not be used to conceal a failed, unavailable, or inconvenient required check.

The `04-QUALITY-GATES.md` document defines the required review and verification activities for each change category and risk level. The matrix must distinguish, at minimum, documentation-only changes, ordinary application changes, and high-risk changes involving storage, timers, recovery, concurrency, backups, privacy, or security.

High-risk changes must receive the reviews and tests appropriate to their risk. Required gates must not be skipped merely because other CI checks pass.

Any exception to a project-level quality requirement must document:

- The requirement and gate affected.
- The reason for the exception.
- The exact affected scope and revision.
- The residual risk and likely impact.
- Compensating controls, if any.
- Explicit owner acceptance and timestamp, where owner acceptance is required.

An owner-approved project-level exception does not bypass mandatory GitHub branch-protection rules, platform-enforced controls, or applicable security requirements. Those controls must be satisfied or formally changed through their own authorized process.

## 20. Document Authority and Precedence

The approved GitHub version of this Project Charter is the governing project policy. ChatGPT Project instructions, conversation context, and summaries must remain consistent with it.

For interpreting instructions, determining project policy, and establishing whether a consequential action is authorized, apply the following order of authority:

1. Explicit project-owner authorization for the exact action and scope.
2. The approved Project Charter maintained in GitHub.
3. Approved repository policies, quality gates, and engineering rules.
4. ChatGPT Project instructions.
5. Conversation history, summaries, and memory.

This order does not allow an owner authorization, chat instruction, or document to bypass mandatory technical controls, enforced GitHub protections, or applicable security requirements. An authorization permits only the action and scope it explicitly identifies; it does not silently amend the Charter.

If a conflict exists between approved repository governance documents, stop the affected work and resolve the conflict through an explicit, documented Charter or policy amendment. Do not choose the less restrictive interpretation by default.

Only an explicitly documented and owner-approved Charter amendment may change the project governance requirements.

ChatGPT Project files are working references. They are not independent authority for current repository facts, formal GitHub reviews, or repository authorization state.

## 21. Security, Privacy, and Test Data

Never commit, upload, or paste into ChatGPT project references, reports, or other project materials:

- Passwords, GitHub tokens, API keys, private keys, or other credentials.
- Real user backups or unredacted application data.
- Unnecessary personally identifiable information.
- Sensitive production logs or private device information.

Use synthetic test data or appropriately redacted fixtures and logs. Collect only the minimum information necessary to diagnose or verify a problem.

Do not place secrets in public or private repository files, ChatGPT project references, test reports, issue descriptions, or CI artifacts.

If a secret is exposed, stop the affected operation, notify the project owner, and revoke or rotate the exposed credential before proceeding. Removing the visible copy alone is not sufficient; assess and address exposure in relevant commit history, logs, artifacts, and other locations where the secret may persist.

## 22. Authorization Validity

Authorization records must be action-specific and revision-aware. Their required identifying fields depend on the action being authorized.

### 22.1 Implementation authorization validity

Implementation authorization is tied to the approved repository, working branch, starting SHA, permitted scope, and allowed operations.

Commits created as part of the authorized implementation do not, by themselves, invalidate that implementation authorization, provided the work remains within the approved scope and follows the repository safety rules.

A change of target branch, an unexpected branch movement or divergence, a materially changed scope, or a need for operations outside those authorized requires work to stop and authorization to be reassessed or renewed before proceeding.

### 22.2 Merge authorization validity

Merge authorization is invalidated by any change to:

- Candidate Head SHA.
- Base branch or Base SHA.
- Authorized merge method or action scope.
- Required review status or validity of the independent approval.
- A required status check or other mandatory merge condition that ceases to be satisfied.

A new merge authorization is required whenever one of these conditions changes materially.

### 22.3 Release authorization validity

Release authorization is invalidated by any change to:

- Release version or release identity.
- Source SHA.
- Artifact identity or Artifact ID.
- Artifact checksum or the file/archive to which it applies.
- Intended publication environment or destination.
- Authorized publication action or scope.

A new release authorization is required whenever one of these conditions changes materially.

No stale approval, previous test result, earlier review, or authorization for a different candidate may be used to authorize a newer revision or artifact.
