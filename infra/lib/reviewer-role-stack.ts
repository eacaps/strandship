import { Stack, StackProps, CfnOutput, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { deriveBedrockArns } from './bedrock-arns';

/**
 * Configuration for the reviewer role stack.
 *
 * These are read from CDK context (passed with `-c key=value` or cdk.json) so
 * the same stack can be deployed for different repos/models without code edits.
 */
export interface ReviewerRoleStackProps extends StackProps {
  /** GitHub username or organisation that owns the repo(s). */
  readonly githubOwner: string;
  /**
   * BASE foundation-model id the reviewer invokes, e.g.
   * "anthropic.claude-sonnet-5-5" (NOT the "us."-prefixed profile).
   * The invoke ARNs (inference profile + per-region foundation models) are
   * derived from this id plus the deploy region/account. Omit when passing
   * `bedrockModelArns` explicitly.
   */
  readonly bedrockModelId?: string;
  /**
   * Optional explicit override of the Bedrock ARN(s) the reviewer may invoke.
   * When set, derivation from `bedrockModelId` is skipped and exactly these
   * ARNs are granted. Use for custom/unusual inference profiles that the static
   * derivation doesn't cover. Plural because the override replaces the entire
   * derived set (a single cross-Region model already needs several ARNs).
   */
  readonly bedrockModelArns?: string[];
  /** Override the inference-profile geo prefix (us|eu|apac); defaults from region. */
  readonly inferenceProfilePrefix?: string;
  /**
   * Whether to create the account-level GitHub OIDC provider. Set to false if
   * you already have one in the account and reference it instead.
   */
  readonly createOidcProvider?: boolean;
}

/**
 * Provisions the GitHub OIDC trust and a least-privilege IAM role that GitHub
 * Actions assumes (via OIDC) to call Amazon Bedrock for the AI code reviewer.
 *
 * No AWS access keys are stored anywhere: GitHub's OIDC token is exchanged for
 * short-lived credentials by assuming this role.
 */
export class ReviewerRoleStack extends Stack {
  constructor(scope: Construct, id: string, props: ReviewerRoleStackProps) {
    super(scope, id, props);

    const { githubOwner } = props;
    const createOidcProvider = props.createOidcProvider ?? true;

    // Resolve the set of Bedrock ARNs the role may invoke.
    //
    // Either the caller passed explicit `bedrockModelArns` to override, OR we
    // derive the inference-profile ARN + per-region foundation-model ARNs from
    // the base `bedrockModelId`. Granting the full set is an Amazon Bedrock
    // requirement for cross-Region inference profiles:
    // invoking the profile can route to the FM in any member region, so the
    // policy must allow the FM ARN in each one (see bedrock-arns.ts).
    let invokeResources: string[];
    if (props.bedrockModelArns && props.bedrockModelArns.length > 0) {
      invokeResources = props.bedrockModelArns;
    } else if (props.bedrockModelId) {
      invokeResources = deriveBedrockArns({
        modelId: props.bedrockModelId,
        region: this.region,
        account: this.account,
        prefix: props.inferenceProfilePrefix,
      }).all;
    } else {
      throw new Error(
        'Provide either bedrockModelId (to derive the invoke ARNs) or ' +
          'bedrockModelArns (to set them explicitly).',
      );
    }

    const githubDomain = 'token.actions.githubusercontent.com';

    // Create the account-level OIDC provider once, or reference an existing one.
    const provider = createOidcProvider
      ? new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
          url: `https://${githubDomain}`,
          clientIds: ['sts.amazonaws.com'],
        })
      : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          'GitHubOidcProvider',
          `arn:aws:iam::${this.account}:oidc-provider/${githubDomain}`,
        );

    // Trust only the owner's workflows. The `sub` condition is the guardrail — it
    // pins the OWNER (the repo side is wildcarded — this deployment is owner-wide
    // by design). GitHub has TWO subject formats and we accept both so adopters on
    // any repo age work:
    //   - legacy:    repo:<owner>/<repo>:<ref-or-event>
    //   - immutable: repo:<owner>@<ownerId>/<repo>@<repoId>:<ref...>
    //     (default for repos created/renamed after 2026-07-15). The `<owner>@`
    //     anchor keeps the owner lock tight — `<owner>@*` matches `eacaps@8252280`
    //     but NOT a different owner like `eacapsfoo`. A single `*` matches across
    //     `:` and `/`, so the wildcards cover the owner id and the repo (+ its id).
    //
    // The trailing `:pull_request` pins the trigger: only PR runs (not `push`,
    // `workflow_dispatch`, tag builds, etc.) can assume the role. We pin it in the
    // `sub` suffix rather than via an `event_name` condition because AWS does NOT
    // support GitHub's custom OIDC claims (only `aud` and `sub`) as trust-policy
    // condition keys — an `event_name` condition can never match and denies every
    // assume. (Verified against this repo via CloudTrail: the PR run's sub ends in
    // `:pull_request`.) Tightening further to THIS reviewer workflow via
    // `job_workflow_ref` (needs review.yml as a reusable `workflow_call` workflow)
    // is the planned next step — see ENHANCEMENTS.md.
    const principal = new iam.OpenIdConnectPrincipal(provider, {
      StringEquals: {
        [`${githubDomain}:aud`]: 'sts.amazonaws.com',
      },
      StringLike: {
        [`${githubDomain}:sub`]: [
          // legacy format: owner pinned exactly, repo wildcarded, PR trigger pinned
          `repo:${githubOwner}/*:pull_request`,
          // immutable format: owner name + @<ownerId>, repo wildcarded, PR trigger pinned
          `repo:${githubOwner}@*/*:pull_request`,
        ],
      },
    });

    const role = new iam.Role(this, 'ReviewRole', {
      roleName: 'github-ai-code-reviewer',
      assumedBy: principal,
      maxSessionDuration: Duration.hours(1),
      description:
        'Assumed by GitHub Actions via OIDC to invoke Bedrock for AI code review.',
    });

    // Least-privilege: invoke only the resolved model/inference-profile ARN(s).
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: invokeResources,
      }),
    );

    new CfnOutput(this, 'RoleArn', {
      description: 'Set this as the AWS_REVIEW_ROLE_ARN secret in your repo.',
      value: role.roleArn,
    });
  }
}
