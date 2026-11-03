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
  /** Repository name allowed to assume the role. Use "*" for all your repos. */
  readonly githubRepo: string;
  /**
   * BASE foundation-model id the reviewer invokes, e.g.
   * "anthropic.claude-sonnet-4-20250514-v1:0" (NOT the "us."-prefixed profile).
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

    const { githubOwner, githubRepo } = props;
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

    // Trust only workflows from the configured repo(s). The `sub` condition is
    // the key guardrail — it restricts which repository can assume the role.
    //
    // The subject is pinned to the `pull_request` event (`...:pull_request`)
    // rather than a wildcard (`...:*`). The reviewer only ever runs on the
    // `pull_request` trigger, so this is a no-op for the current workflow but
    // stops any OTHER event context in the matched repo(s) — a `push`,
    // `workflow_dispatch`, a tag build, etc. — from assuming the role. This
    // matters most when `githubRepo='*'`, where the repo side is already
    // owner-wide.
    //
    // NOTE: if you ever add a non-PR trigger to review.yml (e.g.
    // `workflow_dispatch`), that run's subject will NOT be `:pull_request` and
    // STS will reject it — widen this condition deliberately if so. Pinning the
    // workflow file itself via `job_workflow_ref` is the planned next step (see
    // ENHANCEMENTS.md).
    const principal = new iam.OpenIdConnectPrincipal(provider, {
      StringEquals: {
        [`${githubDomain}:aud`]: 'sts.amazonaws.com',
      },
      StringLike: {
        [`${githubDomain}:sub`]: `repo:${githubOwner}/${githubRepo}:pull_request`,
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
