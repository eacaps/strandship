# strandship — GitHub Actions + OIDC

An AI code reviewer that runs as a **GitHub Actions workflow**. On each pull request,
the workflow checks out the repo, and a [Strands](https://github.com/strands-agents/sdk-python)
agent explores the **local filesystem** for context, reads the project's conventions,
and posts a single review comment.

- **You host nothing** — GitHub runs the compute.
- **AWS auth:** GitHub OIDC → IAM role (no stored AWS keys).
- **GitHub auth:** the workflow's automatic, short-lived `GITHUB_TOKEN`.
- **Exploration:** real local filesystem (`git diff`, `git grep`, file reads).

## Layout

This folder is split into two self-contained siblings, each with its own
toolchain. The agent (what runs the review) and the infra (what grants it AWS
access) are independent concerns, so they live in separate subtrees:

```
strandship/
├── agent/                         # Python — the Strands reviewer (uv)
│   ├── strandship/
│   │   ├── __init__.py
│   │   └── agent.py               # Strands agent + filesystem exploration tools
│   └── pyproject.toml             # Python deps (managed with uv)
├── infra/                         # TypeScript — AWS CDK (npm)
│   ├── bin/app.ts                 # CDK app entry; reads config from context
│   ├── lib/reviewer-role-stack.ts # OIDC provider + least-privilege IAM role
│   ├── lib/bootstrap-stack.ts     # (optional) Bedrock model-access enablement
│   ├── lambda/
│   │   └── bedrock-access-handler/
│   │       └── index.ts           # custom-resource handler (agreement paths)
│   ├── package.json
│   ├── tsconfig.json
│   └── cdk.json
├── .github/workflows/review.yml   # PR trigger, OIDC auth, runs the agent
└── README.md
```

### Why two languages?

- **`agent/` is Python** because [Strands](https://github.com/strands-agents/sdk-python)
  is Python-only. The agent must be Python; there is no choice here.
- **`infra/` is TypeScript** because the deploy layer is an independent concern and
  TypeScript is the most common, most idiomatic CDK language. Keeping it separate
  means each subfolder has exactly one toolchain (`uv` for the agent, `npm`/`cdk`
  for the infra) with no cross-contamination of dependencies.

This app/infra language split is a common industry pattern: the language that
*describes* your infrastructure is independent of the language your code *runs* in.

## How it works

1. A PR is opened/updated → `review.yml` triggers.
2. The workflow checks out the code (full history), sets up `uv`, and runs
   `uv sync --frozen` in `agent/` to install Python dependencies from the
   committed `uv.lock` (reproducible; no floating to new releases).
3. `aws-actions/configure-aws-credentials` exchanges the GitHub OIDC token for
   short-lived AWS credentials by assuming the IAM role from `infra/` — no keys.
4. `uv run python -m strandship.agent` (run from `agent/`) runs the Strands agent. It
   calls `fetch_conventions`, `get_pr_diff`, and explores with `list_directory` /
   `read_file` / `search_code`, then calls `post_review` once. The agent explores
   `GITHUB_WORKSPACE` (the repo root), independent of its working directory.
5. `post_review` shells out to the pre-authenticated `gh` CLI to comment on the PR.

## Setup

### Prerequisites

Before the steps below, you need:

- **AWS credentials** for the target account/region, with permission to create
  IAM roles, an OIDC provider, and (for step 1b) Bedrock model-access agreements.
  Sign in with `aws login` (or your usual profile/SSO), then verify:
  ```bash
  aws sts get-caller-identity   # should print your account id
  aws configure get region      # or set AWS_REGION for the deploy
  ```
  The `cdk bootstrap`/`cdk deploy` commands below fail with a credentials/expired-
  session error if this isn't set up first.
- **Node.js 20+** and **npm** — for the CDK app in `infra/`.
- **A GitHub repository** you own, where you'll add the workflow (steps 2–3).

> The agent's own runtime (steps 2–3) needs `uv` and the `gh` CLI, but those run
> inside GitHub Actions — you don't need them locally just to deploy the infra.

### 1. Deploy the OIDC provider + IAM role (once) — `infra/` (TypeScript CDK)

```bash
cd infra
npm install

# First time in this account/region only (pass your account + region):
npm run bootstrap -- aws://<account-id>/<region>

npx cdk deploy \
  -c githubOwner=<your-github-username> \
  -c githubRepo='*' \
  -c bedrockModelIds=anthropic.claude-sonnet-5-5
```

Copy the `RoleArn` output.

> **Why `npm run bootstrap`?** It runs `cdk bootstrap --app ''`, which bootstraps
> the environment *without* executing this CDK app. The app requires model/owner
> context to synth, so a bare `cdk bootstrap` would fail asking for it —
> bootstrapping is environment-level setup and doesn't need the app's context.
> Because the app is skipped, CDK can't auto-detect the environment, so pass it
> explicitly: `npm run bootstrap -- aws://<account-id>/<region>` (the `--`
> forwards the argument through npm to the `cdk` command).

> **One model id, no ARN hunting.** You pass the **base** model id
> (`anthropic.claude-...`, no `us.` prefix) as `bedrockModelIds`. From it, and the
> deploy region, CDK derives the invoke ARNs the IAM policy needs — the
> cross-Region inference profile *plus* the foundation-model ARN in each region the
> profile spans (an Amazon Bedrock requirement for cross-Region inference). The
> deploy region's geo picks the prefix (`us.`/`eu.`/`apac.`); override with
> `-c inferenceProfilePrefix=<us|eu|apac>` if needed.
>
> `bedrockModelIds` is plural (comma-separated) to reserve the shape for
> multi-model support; **exactly one** entry is supported today.
>
> **Advanced override.** For a custom/unusual inference profile the static
> derivation doesn't cover, pass `-c bedrockModelArns=<arn>` (comma-separated for
> several) to set the invoke ARN(s) explicitly instead of deriving them.

> If you already have a GitHub OIDC provider in the account, pass
> `-c createOidcProvider=false` so CDK references the existing one instead of
> creating a duplicate (an account can only have one provider per URL).

### 1b. (Optional) Automate Bedrock model-access enablement — the `BootstrapStack`

Before the reviewer can invoke a model, that model's **access must be enabled in
your account**. You can do this manually in the Bedrock console (Model access), or
let the optional `BootstrapStack` do it on deploy. It uses the **same**
`bedrockModelIds` you already pass — the base id drives both the derived invoke
ARNs and the access agreement, so there's nothing extra to specify:

```bash
npx cdk deploy --all \
  -c githubOwner=<your-github-username> \
  -c githubRepo='*' \
  -c bedrockModelIds=anthropic.claude-sonnet-5-5
```

> **One model for now.** `bedrockModelIds` is plural (comma-separated) to reserve
> the shape for multi-model support, but **exactly one** entry is supported today —
> passing more than one fails the deploy. Multi-model enablement is a planned
> enhancement (see [`ENHANCEMENTS.md`](./ENHANCEMENTS.md)).

> ⚠️ **This accepts the model's EULA in your account.** For third-party models,
> deploying the `BootstrapStack` creates a *foundation-model agreement*, which
> constitutes accepting that model's End User License Agreement. This is a
> deliberate side effect of the deploy. If you'd rather accept terms explicitly,
> omit `bedrockModelIds` on the `BootstrapStack` (deploy only the role stack) and
> enable access in the console instead.

**The model identifiers:**

| Context key | Form | Used for |
|---|---|---|
| `bedrockModelIds` | **base** model id (`anthropic.claude-...`, no `us.` prefix); one entry for now, plural to reserve the multi-model shape | both the derived **invoke ARNs** (IAM policy) and the **agreement** (model access). This is the one you normally pass. |
| `bedrockModelArns` | inference-profile ARN(s), optional (plural, comma-separated) | **override** — set the invoke ARN(s) explicitly instead of deriving them. Replaces the entire derived set; does not affect the agreement. |

**How the agreement path is chosen.** The handler branches on the model id's
provider prefix:

| Provider prefix | Path taken | EULA / form |
|---|---|---|
| `amazon.*` (Nova/Titan) | none — verifies availability; first-party models have no programmatic agreement. If not already enabled, it errors and asks you to enable once in the console. | none |
| `anthropic.*` (Claude) | one-time per-account use-case form **+** `CreateFoundationModelAgreement` | accepts EULA + submits Anthropic form |
| anything else (Meta, Mistral, Cohere, AI21, …) | `CreateFoundationModelAgreement` only | accepts EULA |

**Behavior & safety notes:**
- **Idempotent:** the handler calls `GetFoundationModelAvailability` first and does
  nothing if the model is already `AVAILABLE`.
- **Re-runs on model change:** the model id is a custom-resource property and is
  baked into the resource's physical id, so changing it triggers enablement for the
  new one on the next deploy. Since the invoke ARNs are derived from the same
  `bedrockModelId`, IAM and access stay in sync automatically.
- **Polls to AVAILABLE:** after creating an agreement it waits (Anthropic agreements
  can sit in `PENDING`), failing the deploy with a clear message on timeout/`ERROR`.
- **On delete, access is left in place** (a no-op) — model access is account-level
  and likely outlives the stack.
- **Isolated privileged handler:** enabling access needs broad Bedrock agreement
  permissions, so the handler Lambda has its **own** role with those permissions,
  kept separate from the tightly-scoped invoke-only `ReviewRole`. This privileged
  role exists only in the `BootstrapStack`, not in the per-repo review path.

> **One model today; multi-model is planned.** `bedrockModelIds` accepts a single
> entry for now. See [`ENHANCEMENTS.md`](./ENHANCEMENTS.md) for the generalization
> plan (looped custom resources, once-only Anthropic form, multi-ARN policy).

### 2. Configure the repo

Do this **once per repo** you want reviewed (the infra in step 1 is deployed once
per account, but each repo needs its own secret).

Add a repository **secret**:
- `AWS_REVIEW_ROLE_ARN` → the `RoleArn` from step 1.

> **Lost the ARN?** It's a stack output, so you don't need to re-deploy to get it.
> From `infra/`, reprint it any time (pass your profile/region):
> ```bash
> npm run show-role-arn -- --profile <your-profile> --region <your-region>
> ```

Add repository **variables** (optional; defaults shown):
- `AWS_REGION` = `us-east-1`
- `BEDROCK_MODEL_ID` = `anthropic.claude-sonnet-5-5`

> **Same value as the infra.** `BEDROCK_MODEL_ID` is the **base** model id —
> the *identical* string you passed to the infra as `bedrockModelIds`. The agent
> derives the cross-Region inference-profile id it actually invokes
> (`us.`/`eu.`/`apac.` prefix) from this id plus `AWS_REGION`, using the same geo
> rule the infra uses to derive the IAM policy ARNs. So there is **one** value to
> keep straight across both sides, not a base-vs-profile pair.
>
> If you set `BEDROCK_MODEL_ID` to a value that is already a profile id
> (`us.anthropic.claude-...`) or a full ARN, the agent uses it verbatim.

Make sure **Bedrock model access** is enabled for that model in the region —
either via the console, or automatically with the optional `BootstrapStack`
(step 1b).

### 3. Add the workflow to each repo

Copy `.github/workflows/review.yml` and the `agent/` folder into each repo you
want reviewed. (The `infra/` folder only needs to be deployed once per account —
it is not copied into target repos.) Open a PR to test.

## Conventions

The agent looks for `CONVENTIONS.md`, then `CONTRIBUTING.md`, then
`.github/CONVENTIONS.md` in the repo.

## Security

- **No stored AWS keys** — OIDC issues short-lived credentials per run.
- **IAM is least-privilege** — the role can only `bedrock:InvokeModel` on the one
  model ARN, and the trust policy restricts it to your repos (`sub` condition).
- **GitHub token is short-lived and repo-scoped** — injected per run.
- **Capability-constrained agent** — the only write tool is `post_review`, fixed to
  the PR under review; there is no network/exfiltration tool and no tool that can
  read the runner's environment or runtime credentials (the agent's file tools are
  confined to the checked-out repo). `post_review` output is size-capped
  (`MAX_REVIEW_BYTES`) so a runaway or injected agent can't dump unbounded content
  into the public comment.
- **Threat-model assumption — no plaintext secrets in the reviewed repo** — the
  reviewer reads files from the checked-out tree and can quote them back in its
  (world-readable) review comment. This is only a safe boundary if the repo under
  review does **not** contain committed plaintext secrets (`.env` files, private
  keys, credentials). That is the expected hygiene for any repo, and the runtime
  credentials this workflow uses (short-lived OIDC AWS creds, the scoped
  `GITHUB_TOKEN`) live in the job environment — which the agent has no tool to
  read — not in the repo. If you knowingly commit secrets to a repo, do not point
  the reviewer at it.
- **Path traversal guarded** — file tools refuse paths outside the repo root.
- **Same-repo + membership gate (abuse control)** — the job runs only when the PR
  branch is **not from a fork** (`head.repo.fork == false`) **and** the author's
  `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR`. The fork check is
  the real guardrail: `fork` is an immutable property of the PR, so unlike
  `author_association` (a mutable payload field) it can't flip to a trusted value
  after a member interacts with an outside contributor's PR. It also matches what
  can actually run the agent — fork PRs on `pull_request` get no secrets and can't
  assume the role. The association list is a secondary **abuse/cost backstop, not a
  trust boundary** (don't rely on it for injection safety; the capability-
  constrained agent above is what makes injection safe). A stronger per-identity
  abuse control (bucketed rate limiting) is a planned enhancement — see
  [`ENHANCEMENTS.md`](./ENHANCEMENTS.md).
- **Leaked role ARN is low-risk** — `AWS_REVIEW_ROLE_ARN` is an identifier, not a
  credential. To assume the role a caller needs a GitHub OIDC token whose `sub`
  matches `repo:<your-owner>/<repo>:pull_request`; a fork under someone else's
  account produces a non-matching `sub`, so STS rejects it. The real lock is the
  **owner-scoped `sub` condition** in the trust policy — never wildcard the owner
  side. The subject is also pinned to the `pull_request` event, so only PR runs
  (not an arbitrary `push`/`workflow_dispatch` in a matched repo) can assume it.
- **Pinned supply chain** — third-party actions are pinned to immutable commit
  SHAs (not movable tags), and Python deps install with `uv sync --frozen` against
  a committed `uv.lock`, so a compromised upstream tag or a freshly published
  malicious release cannot inject code into the credentialed job.
- **Fork trade-off:** this uses `pull_request`, so **fork PRs run without secrets**
  and won't be reviewed (they can't assume the AWS role). That's the safe default.
  If you want to review fork PRs you'd switch to `pull_request_target` and add a
  maintainer-gated `/review` label check — do this deliberately, it's a known footgun.
- **Concurrency cap** — a per-PR `concurrency` group with `cancel-in-progress`
  prevents parallel runs stacking on rapid pushes.
- **Bounded loop** — `MAX_ITERATIONS` caps Bedrock cost on pathological PRs.

## Local testing

Run the agent from the `agent/` subfolder:

```bash
# Install uv: https://docs.astral.sh/uv/getting-started/installation/
cd agent
uv sync --frozen   # install the exact locked versions (same as CI)
export GITHUB_REPOSITORY=you/your-repo
export PR_NUMBER=1
export BASE_REF=origin/main
export AWS_REGION=us-east-1
export GITHUB_WORKSPACE=/path/to/checked-out/repo   # defaults to "." if unset
# AWS creds via your usual profile; gh authenticated via `gh auth login`.
uv run python -m strandship.agent
```

To work on the infra:

```bash
cd infra
npm install
npm run typecheck        # tsc --noEmit
npx cdk synth -c githubOwner=you -c bedrockModelIds=anthropic.claude-sonnet-5-5   # preview the CloudFormation
```

## License

Licensed under the [Apache License, Version 2.0](./LICENSE). See [`NOTICE`](./NOTICE)
for attribution.
