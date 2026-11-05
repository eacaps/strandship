# Enhancements / future work — strandship

Known, deliberately-deferred work specific to the **GitHub Actions + OIDC**
implementation. These are **not bugs** — current behavior is intentional for v1.
After v1 is published, migrate each item to a GitHub issue.

---

## Infra

### Multiple models per deployment (BootstrapStack + role policy)
Today the `BootstrapStack` enables exactly **one** model and the reviewer role grants
invoke on a single model's derived ARN set. The invoke ARNs (inference profile +
per-region foundation models) are already **derived** from the base `bedrockModelId`
(see `lib/bedrock-arns.ts`), so there is no separate ARN to pass per model — the
remaining work is to accept and loop over *several* ids.

To generalize:
- `bin/app.ts`: accept a comma-separated list in `bedrockModelIds`
  (parsing is already there; remove the single-entry guard).
- `BootstrapStack`: loop to create one custom resource per model (distinct construct
  id + the existing model-scoped physical id → per-model create/update/delete).
- Hoist the once-per-account Anthropic use-case form out of the per-model path so it
  isn't resubmitted for each Anthropic model.
- `ReviewerRoleStack`: call `deriveBedrockArns` per model and grant the union of all
  ARN sets in the policy `Resource` (the single-model derivation already exists; this
  is just mapping it over the list).
- The static geo→member-region map in `bedrock-arns.ts` is maintained by hand; if it
  drifts, switch to a deploy-time `GetInferenceProfile` lookup (the "dynamic
  derivation" option) to read member regions from the API instead.

Note: the agent still invokes a single model per run via `BEDROCK_MODEL_ID`, so this
only enables "pre-enable a set so switching is instant / no agreement re-run." Using
several models simultaneously is separate agent work (below).

### Verify the `amazon.*` (native model) access path against a live account
The handler assumes native Amazon models (Nova/Titan) have no programmatic agreement
and errors asking for a one-time console enable if not already available. Confirm
whether a fresh account needs any access step at all for Nova, or if it's on by
default — and adjust the branch accordingly.

### Confirm Marketplace-subscription requirements per provider
Some third-party Bedrock models may require an AWS Marketplace subscription in
addition to `CreateFoundationModelAgreement`. The handler role already includes
`aws-marketplace:Subscribe`/`ViewSubscriptions`, but the exact per-provider flow
(Meta, Mistral, Cohere, AI21, …) is unverified. Validate on a live deploy.

### Reusable workflow for multi-repo adoption
Per-repo setup currently means copying `.github/workflows/review.yml` + the `agent/`
folder into each repo. Convert `review.yml` into a callable (`workflow_call`)
reusable workflow published in this repo, so adopters add a ~10-line caller stub
(`uses: <owner>/strandship/.github/workflows/review.yml@v1`) instead of copying
the agent. Depends on versioning (below) so the `@v1` ref is stable.

### Pin role trust to the reviewer workflow via `job_workflow_ref`
The trust policy scopes `sub` by OWNER only (two patterns, for GitHub's legacy and
immutable subject formats), with the repo wildcarded and the trigger pinned via the
`:pull_request` suffix:
`repo:<owner>/*:pull_request` and `repo:<owner>@*/*:pull_request`. This is
owner-wide by design (there is no `githubRepo` param — breadth is always the owner's
namespace). It trusts **any `pull_request` workflow in any of the owner's repos** —
not only the reviewer. The membership gate in `review.yml` does not help here: that
gate lives in one workflow file, whereas the IAM trust policy is what actually
governs who can assume the role.

Owner-wide is a deliberate adoption choice (drop the reviewer into any of the owner's
repos with no per-repo redeploy), and the owner-scoped `sub` still confines assumption
to the owner's own namespace. The residual gap is purely *within* that namespace: any
`pull_request` workflow in any of the owner's repos — not only the reviewer — can
assume the role. The GitHub OIDC token carries a separate `job_workflow_ref` claim
identifying the *workflow file* that requested the token (for reusable workflows, the
**defining** workflow, not the caller), so we can bind the role to *our reviewer
workflow* regardless of which repo runs it — closing the residual gap **without**
giving up the owner-wide convenience.

Already shipped (partial mitigation): the trigger is pinned via the `sub` suffix
(`:pull_request`), so non-PR events (`push`, `workflow_dispatch`, tag builds) in the
owner's repos cannot assume the role. `job_workflow_ref` is the complete fix that
remains (it pins the *workflow*, not just the event).

> **Note on the event pin:** it MUST live in the `sub` suffix, NOT an `event_name`
> condition. AWS does not support GitHub's custom OIDC claims (only `aud` and `sub`)
> as trust-policy condition keys, so an `event_name` condition can never match and
> denies every assume (learned the hard way). Verify whether `job_workflow_ref` is a
> supported condition key on AWS before building the fix below — if AWS treats it as a
> custom claim too, this approach won't work and the per-workflow lock needs rethinking.

To generalize:
- `ReviewerRoleStack`: add an optional `jobWorkflowRef` context param and, when set, add
  a `StringLike` condition on
  `token.actions.githubusercontent.com:job_workflow_ref` of the form
  `<owner>/strandship/.github/workflows/review.yml@<ref>` alongside (not replacing)
  the existing `sub`/`aud` conditions.
- Pin the `@<ref>` to a ref you control (a protected tag/branch); a movable tag weakens
  the binding to whatever tag protection you have.

Caveats to resolve at implementation time:
- **Reusable vs copied workflow.** `job_workflow_ref` points at the *defining* workflow,
  so a single pinned path covers all adopter repos **only once `review.yml` is a
  `workflow_call` reusable workflow** (see *Reusable workflow for multi-repo adoption*
  below). In today's copied-file model the claim resolves to each adopter repo's own
  copy, so until the reusable-workflow migration lands, the shipped event pin is the
  mitigation and `job_workflow_ref` pinning should wait for that migration.
- **Verify the exact claim string/format** against GitHub's current OIDC docs before
  pinning a trust policy to it (claim key, ref encoding `@refs/tags/v1` vs `@v1`).
- Depends on / pairs with *Reusable workflow for multi-repo adoption*; update the
  README's Security section ("Leaked role ARN is low-risk" / fork trade-off) to reflect
  the tighter binding.

### Bucketed rate limiting (per-identity abuse control)
Today the only abuse/cost backstops are the `author_association` gate (a coarse
allow-list — any OWNER/MEMBER/COLLABORATOR can trigger unlimited runs) and the per-PR
`concurrency` group (dedupes rapid pushes to *one* PR, but does nothing across PRs or
over time). A single trusted-but-careless or compromised collaborator account could
still open many PRs (or rapidly churn several) and drive unbounded Bedrock spend /
Actions minutes. The `COLLABORATOR` tier is the weakest link here since it is often
granted liberally.

Add a rate limit keyed on a stable identity (PR author login, or the triggering
actor) with a token-bucket / fixed-window budget — e.g. "N reviews per actor per
rolling hour, M per day." When the bucket is exhausted, skip the review and post a
short comment explaining the limit rather than silently running.

To generalize:
- **State store:** a bucket needs cross-run state, which Actions doesn't give you for
  free. Options, lightest first: the Actions **cache** (simple, but evictable and
  racy under concurrency — acceptable for a soft limit); a repo **variable**/commit
  status (durable, but write-contention under parallelism); or a tiny external store
  (DynamoDB with a TTL + atomic counter) for an accurate limit. For a personal
  project the cache-based soft limit is likely enough; call out the accuracy
  trade-off wherever it lands.
- **Key choice:** prefer `github.event.pull_request.user.login` (PR author) so churn
  on one PR and spreading across many PRs both count against the same budget. Keep
  the existing per-PR `concurrency` group as the rapid-push dedupe; rate limiting is
  the orthogonal cross-PR/time bound.
- **Placement:** a pre-review job/step that checks-and-decrements the bucket and sets
  an output the review job gates on (so the expensive `uv sync` + Bedrock steps don't
  run when the limit is hit).
- **Make the budget configurable** (repo variables, with sane defaults) and document
  it alongside the membership gate in the README's Security section — explicitly as
  the abuse control the `author_association` gate is *not*.

### Runner egress allowlist (defense-in-depth for the credentialed job)
The review job holds short-lived AWS credentials (via OIDC) and the scoped
`GITHUB_TOKEN` in the runner for the job's duration. We already pin the supply chain
(SHA-pinned actions + `uv sync --frozen` against a committed `uv.lock`), which removes
the most likely code-injection vector. An egress allowlist is the complementary
**containment** control: if something hostile *does* execute in the job (a dependency
that slips the lockfile, a compromised pinned action), restricting outbound network
stops it from exfiltrating the credentials (or stolen content) off-box.

This is deliberately deferred, not forgotten: it is higher-friction than the pins
(a wrong allowlist breaks the job) and adds another third-party action to vet and pin,
so it wants a deliberate decision rather than a silent add.

To generalize:
- Add a hardening step as the **first** step of the job (e.g. `step-security/harden-runner`
  in `egress-policy: block` mode), SHA-pinned like the other actions, with a curated
  allowlist of the endpoints the job legitimately needs:
  - **AWS Bedrock + STS** for the region in use (`bedrock-runtime.<region>.amazonaws.com`,
    `sts.amazonaws.com` / regional STS) — the actual model calls and the OIDC role
    assumption.
  - **PyPI + the `astral` CDN** (`pypi.org`, `files.pythonhosted.org`, and uv's
    download host) for `uv sync`.
  - **GitHub API/host** (`api.github.com`, `github.com`) for `actions/checkout` and the
    `gh pr comment` in `post_review`.
- Start in `audit` mode (log, don't block) for a run or two to capture the real egress
  set, then flip to `block` once the allowlist is confirmed — avoids a
  false-positive breakage on first deploy.
- Keep the allowlist in the workflow (or a small reusable snippet) and revisit it when
  the region, model provider, or package set changes — a missing host surfaces as a
  blocked connection, not a silent failure.
- Pairs with the supply-chain pins already in place: pins reduce the chance of
  compromise; the egress allowlist bounds the blast radius if one happens anyway.

### Spend/abuse controls on the model (per-day meter + observability)
Bedrock has **no native per-day request or dollar cap** — the only native levers are
per-*minute* quotas (TPM, and RPM for some models), which reset each minute, plus
observe-and-alert cost tooling (Cost Explorer, tagged application inference profiles,
AWS Budgets **alerts**). None of these is a hard "N per day, then stop." These controls
matter because the cost at risk is **account-wide** (shared across every repo that
assumes the role), so a per-repo counter can't bound it and "spin up another repo"
otherwise resets any per-repo limit.

> The cheapest mitigation — lowering the account's per-minute RPM quota as a velocity
> backstop — is an **operational step**, not engineering work, so it lives in
> [`OPS.md`](./OPS.md) ("Bedrock RPM velocity backstop"), not here. It bounds the daily
> worst case (`RPM × 1440`) but is not a true daily cap; the two items below are.

1. **DynamoDB real-time per-day meter (the actual hard cap — enhancement).** A true
   "N invocations (or $X) per UTC day, then refuse" requires consumed-state tracking,
   which a per-minute rate quota fundamentally is not. Build a small meter in the
   existing CDK stack:
   - A DynamoDB table keyed by day bucket (e.g. `pk = review#YYYY-MM-DD`) with an
     **atomic** `UpdateItem … ADD count 1` and a `ConditionExpression` that rejects
     once the count exceeds the configured budget — atomicity is what makes it correct
     under concurrent runs (the property the Actions-cache approach lacked).
   - Enforcement options: (a) a pre-review step in the workflow that calls the meter
     (needs a small extra IAM grant on the reviewer role — scope it to the one table)
     and gates the expensive `uv sync` + Bedrock steps on the result; or (b) the agent
     checks/decrements at the start of `main()` before constructing the agent. The
     workflow-step form keeps the cost gate *before* dependency install.
   - Make the daily budget configurable (CDK context + a repo variable surfaced into
     the workflow) with a sane default; document it as the account-wide hard cap that
     RPM and the per-repo concurrency group are **not**.
   - On over-budget, skip and optionally post a one-line "daily review budget reached"
     comment rather than failing silently.
   - TTL-expire old day rows so the table self-cleans.

2. **Metrics + alarms on model calls (observability — enhancement).** Independent of
   enforcement, emit and alarm on invocation volume so abuse/cost spikes are *seen*
   quickly, not discovered on the bill:
   - **Native, zero-instrumentation:** CloudWatch `AWS/Bedrock` metrics
     (`Invocations`, `InputTokenCount`, `OutputTokenCount`, `InvocationThrottles`,
     `InvocationClientErrors`) — add CloudWatch alarms (e.g. invocations/hour over a
     threshold, or any sustained throttling) with an SNS notification. Can be defined
     in the CDK stack.
   - **Cost-side:** an AWS Budget on the tagged application inference profile with
     tiered thresholds (50/80/100% + forecasted) — alerting, not enforcing, and
     complementary to the hard meter above.
   - **Per-run app metric (optional):** have the agent emit a custom metric / EMF line
     per review (e.g. invocation count, token totals from the Bedrock response
     metadata) so you can alarm on per-review cost outliers, not just account totals.
   - Wire alarms to a real channel (SNS → email/Slack). The meter (item 1) stops
     spend; these alarms tell you abuse is happening and whether to tighten the budget.

### License + versioning (prerequisite for distribution)
Add a `LICENSE` (MIT or Apache-2.0 — Apache-2.0 leans better for a cloud tool) and a
semver tagging convention (`v1.0.0` with a moving `v1` major alias, the GitHub
Actions norm). Required before the reusable-workflow `@v1` reference is meaningful,
and before others can legally adopt the project.

### Automate releases with semantic-release
Implement the versioning above with [semantic-release](https://semantic-release.gitbook.io/):
automate version bumps, Git tags, `CHANGELOG`, and GitHub releases from
[Conventional Commits](https://www.conventionalcommits.org/) — removing manual
`vX.Y.Z` tagging. This is the mechanism that produces the stable tags the reusable
workflow's `@v1` pin depends on.

Considerations:
- **Prerequisite:** a Conventional Commits convention, a CI release job, and a token
  allowed to push tags/create releases.
- **Moving major alias:** Actions consumers track `@v1` (a moving major tag).
  semantic-release emits `vX.Y.Z`; keeping a moving `v1` alias current needs an extra
  step/plugin so the reusable-workflow `@v1` reference resolves.
- **Agent/infra split:** this project has two toolchains (the Python `agent/` and
  the TypeScript `infra/`). Vanilla semantic-release assumes one package → one
  version line. For v1, use a **single project-wide version** across both; independent
  per-toolchain versioning would need monorepo tooling/plugins and can be deferred.

### Automated CDK deploy via GitHub Actions (with a least-privilege bootstrap)
Infra is deployed manually/locally today. A deploy workflow could run `cdk deploy`
in CI (push to `main` / tag / `workflow_dispatch`) using a **second** OIDC role —
separate from the tiny reviewer invoke role, since deploys need broad create
permissions.

**Do not** ship this with CDK's default `AdministratorAccess` bootstrap behind a
workflow trigger. Instead, derive a scoped CloudFormation execution policy and
re-bootstrap with it (`cdk bootstrap --cloudformation-execution-policies <arn>`):

- **Preferred — IAM Access Analyzer (observed-activity, first-party, accurate):**
  1. Bootstrap/deploy once with the broad default in your account.
  2. Run IAM Access Analyzer policy generation over that deploy's CloudTrail window
     to capture exactly the actions the deploy used.
  3. Review the generated policy, then re-bootstrap with it as the CFN execution
     policy.
  4. Regenerate when the stacks gain new resource types (a missing action surfaces
     as `AccessDenied` at deploy).
- *Alternative — static:* `iann0036/aws-leastprivilege` predicts the policy from the
  template (ahead-of-time, but best-effort/incomplete and third-party; review output).
- **Do not hand-author** the policy — use one of the tools above.

Additional guardrails for the deploy path:
- Scope the deploy role's trust to **this repo + `main`/a protected environment**
  only (not `githubRepo='*'`), via the `sub` condition.
- Gate with a **GitHub Environment + required reviewers** so a human approves deploys.
- The initial custom `cdk bootstrap` + deploy-role creation remain a **one-time
  manual** step (chicken-and-egg: the automation can't create its own permissions).

Lower-risk precursor worth doing first: **`cdk diff` on infra PRs** (read-only role,
no deploy power) for automated visibility into infra changes without the privileged
deploy role.

### CI lint + typecheck
No automated linting/typechecking runs today — `tsc --noEmit` has been run by hand.
Add a CI job (on PRs) covering both toolchains:
- **TypeScript (`infra/`):** `tsc --noEmit` for the CDK app **and** the Lambda
  handler (`lambda/bedrock-access-handler`). This matters because Lambda has no
  TypeScript runtime — `NodejsFunction` esbuild-bundles `.ts` to JS and esbuild only
  *strips* types, so type **errors** are caught only by `tsc`, not at build/runtime.
  Add ESLint (e.g. `@typescript-eslint`) for style/correctness.
- **Python (`agent/`):** `ruff` (lint + format) and a type checker (`mypy` or
  `pyright`), run via `uv`.

Keep it fast and PR-gating. Pairs naturally with the `cdk diff`-on-PR job above.

### Adopter "Getting Started" guide
The current READMEs read as author notes. For external adopters, add a dedicated
guide: prerequisites, exact deploy commands with every placeholder, the
`createOidcProvider=false` fork for accounts that already have an OIDC provider,
Bedrock enablement (incl. the EULA-acceptance note), and a troubleshooting list
(AccessDenied → model not enabled; provider-exists → set the flag; job skipped →
`author_association` gate).

---

## Agent

### Multi-model / fallback awareness
The agent invokes exactly one model per run (`BEDROCK_MODEL_ID`). A future version
could be model-aware — e.g. try a primary model and fall back to another, or route by
PR size/complexity. Pairs with the multi-model infra item above.

### External conventions source flexibility
The agent reads in-repo `CONVENTIONS.md`/`CONTRIBUTING.md`. Could support a hosted
URL or a shared standards repo as an additional conventions source.

### Large-PR handling / diff chunking
`get_pr_diff` returns the whole merge-base diff as one string and `read_file` caps a
single file at `MAX_FILE_BYTES` (100 KB), but nothing bounds the *total* diff size.
A very large PR can blow past the model's context window, and the failure mode is a
hard model error rather than a graceful degrade. Most simple diff→LLM actions already
chunk-and-summarize for exactly this reason.

To generalize:
- Add a total-diff budget (bytes or token estimate). When the diff fits, behave
  exactly as today (no regression for the common case).
- When it exceeds the budget, split the diff — ideally **per-file** (or per-hunk for
  pathological single-file diffs) — review each chunk, then do a final summarization
  pass that merges per-chunk findings into one `post_review` call. Keep the
  "exactly one review comment" contract.
- Consider surfacing truncation explicitly in the review ("N files omitted for
  size") so a silently-partial review is never mistaken for a clean one.
- Pairs with the PR-size routing idea in *Multi-model / fallback awareness* above:
  route large/complex PRs to a larger-context model instead of (or before) chunking.

### Verification / false-positive filtering pass
The agent is single-pass and single-agent: it explores, then calls `post_review`
once with whatever it found. There is no second look to filter false positives.
Claude's managed Code Review and Qodo's multi-agent flow both run a **verification
pass** (or dedicated per-concern agents + a filter) and report measurably lower
noise as a result.

To generalize:
- Add an optional verification step after the agent drafts findings and **before**
  `post_review`: re-prompt the model with the draft findings + the relevant diff/
  context and ask it to drop anything it can't substantiate, downgrade speculation,
  and de-duplicate. Only the surviving findings get posted.
- A lighter-weight variant stays single-agent: a self-critique turn in the existing
  loop (cheaper, no orchestration) before the final `post_review`.
- A heavier variant mirrors the multi-agent pattern (separate correctness / security
  / design agents → merge → verify); more capable but more Bedrock cost and
  orchestration. Weigh against `MAX_ITERATIONS` / cost goals — gate behind a flag so
  it's opt-in.
- Noise reduction here reinforces the existing prompt rule to skip nitpicks and empty
  praise; treat review-noise as the metric to improve.

### Inline line comments
`post_review` shells out to `gh pr comment`, so the agent posts a single summary
comment on the PR. CodeRabbit and claude-code-action post **inline comments anchored
to specific lines**, which is where reviewers expect findings and makes them far
easier to act on. This is a UX gap, not a correctness one.

To generalize:
- Have the agent emit structured findings (file path, line/range, body) instead of
  one Markdown blob, then post them as a review with line comments — e.g.
  `gh pr review` / `gh api` against the reviews endpoint, which anchors comments to
  positions in the diff.
- Keep a short top-level summary comment alongside the inline comments (the "review
  body"), preserving today's at-a-glance output.
- Watch the fork/permissions interaction: posting a *review* (vs a plain issue
  comment) exercises different token scopes, and the official actions have hit
  review-posting edge cases concentrated on `pull_request_target` — e.g.
  [claude-code-action #621](https://github.com/anthropics/claude-code-action/issues/621)
  (prompt-driven "agent mode" silently posts only to the Actions summary, not the PR)
  and [#705](https://github.com/anthropics/claude-code-action/issues/705)
  (`use_sticky_comment` doesn't work on `pull_request_target`). Both are now closed,
  but they map the hazards. Validate the posting path on the same-repo
  `pull_request` trigger we actually use before assuming parity with the
  summary-comment path.
- Line anchoring must map findings to positions in the **diff**, not arbitrary file
  lines — the reviews API comments on diff positions, so findings outside the changed
  hunks need a fallback (fold into the summary body).
