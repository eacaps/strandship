import { Stack, StackProps, CfnOutput, Duration, CustomResource } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import * as path from 'path';

export interface BootstrapStackProps extends StackProps {
  /**
   * BASE foundation-model id to enable access for (NOT the "us."-prefixed
   * inference profile). Example: "anthropic.claude-sonnet-4-20250514-v1:0".
   * The provider prefix selects the agreement path.
   */
  readonly bedrockModelId: string;
  /**
   * Optional Anthropic use-case form fields (only used for anthropic.* models).
   * Sensible defaults are applied in the handler if omitted.
   */
  readonly useCase?: {
    readonly companyName?: string;
    readonly companyWebsite?: string;
    readonly intendedUsers?: string;
    readonly industryOption?: string;
    readonly useCases?: string;
  };
}

/**
 * Enables Amazon Bedrock model access for a chosen model via a custom resource,
 * branching on the model's provider:
 *   - amazon.*    : no agreement (verify/guide to console);
 *   - anthropic.* : one-time use-case form + CreateFoundationModelAgreement;
 *   - other       : CreateFoundationModelAgreement only.
 *
 * ⚠️ Deploying this stack for a third-party model ACCEPTS that model's EULA in the
 * deploying AWS account. See the handler and README.
 *
 * The handler role is deliberately isolated and privileged (it needs broad Bedrock
 * agreement permissions) — kept separate from the tightly-scoped invoke-only role
 * in the reviewer role stack.
 */
export class BootstrapStack extends Stack {
  constructor(scope: Construct, id: string, props: BootstrapStackProps) {
    super(scope, id, props);

    const { bedrockModelId } = props;

    // Isolated, privileged role for the agreement handler. These actions can't be
    // meaningfully resource-scoped (agreements are created before the resource
    // "exists"), so they are account/region-bounded by the deploy environment.
    const handlerRole = new iam.Role(this, 'BedrockAccessHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description:
        'Privileged role for the Bedrock model-access custom resource. Isolated ' +
        'from the reviewer invoke role.',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });

    handlerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:GetFoundationModelAvailability',
          'bedrock:ListFoundationModelAgreementOffers',
          'bedrock:CreateFoundationModelAgreement',
          'bedrock:DeleteFoundationModelAgreement',
          'bedrock:PutUseCaseForModelAccess',
          'bedrock:GetUseCaseForModelAccess',
          // Some agreement flows touch AWS Marketplace subscriptions.
          'aws-marketplace:Subscribe',
          'aws-marketplace:ViewSubscriptions',
        ],
        resources: ['*'],
      }),
    );

    const onEvent = new NodejsFunction(this, 'BedrockAccessHandler', {
      entry: path.join(__dirname, '..', 'lambda', 'bedrock-access-handler', 'index.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      role: handlerRole,
      // The agreement + poll loop can run for several minutes (esp. Anthropic).
      timeout: Duration.minutes(14),
      memorySize: 256,
      bundling: {
        // @aws-sdk/client-bedrock (control plane) is not guaranteed in the Lambda
        // runtime, so bundle it rather than marking it external.
        externalModules: [],
      },
    });

    const provider = new Provider(this, 'BedrockAccessProvider', {
      onEventHandler: onEvent,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // The model id is a resource PROPERTY, so changing it triggers an update; the
    // handler returns a model-scoped PhysicalResourceId, so a change is a
    // replacement (new model enabled, old left in place by the no-op Delete).
    new CustomResource(this, 'BedrockModelAccess', {
      serviceToken: provider.serviceToken,
      properties: {
        modelId: bedrockModelId,
        region: this.region,
        companyName: props.useCase?.companyName ?? '',
        companyWebsite: props.useCase?.companyWebsite ?? '',
        intendedUsers: props.useCase?.intendedUsers ?? '',
        industryOption: props.useCase?.industryOption ?? '',
        useCases: props.useCase?.useCases ?? '',
      },
    });

    new CfnOutput(this, 'EnabledModelId', {
      description: 'The base foundation-model id for which access was enabled.',
      value: bedrockModelId,
    });
  }
}
