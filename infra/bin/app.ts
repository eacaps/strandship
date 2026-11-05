#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { ReviewerRoleStack } from '../lib/reviewer-role-stack';
import { BootstrapStack } from '../lib/bootstrap-stack';

const app = new App();

// Configuration comes from CDK context. Pass on the CLI, e.g.:
//   cdk deploy --all \
//     -c githubOwner=my-user \
//     -c githubRepo='*' \
//     -c bedrockModelIds=anthropic.claude-sonnet-5-5
// or set defaults in cdk.json under "context".
//
// `bedrockModelIds` is the BASE model id (no "us." prefix). From it we derive
// BOTH the invoke ARNs (inference profile + per-region foundation models, in
// ReviewerRoleStack) AND the model-access agreement (BootstrapStack). One id,
// no ARN hunting. Advanced: pass `bedrockModelArns` to override the derived
// invoke ARNs for a custom inference profile.
const githubOwner = app.node.tryGetContext('githubOwner');
const githubRepo = app.node.tryGetContext('githubRepo') ?? '*';
const createOidcProvider =
  app.node.tryGetContext('createOidcProvider') !== 'false';
const inferenceProfilePrefix = app.node.tryGetContext('inferenceProfilePrefix');

// Optional explicit override of the invoke ARN(s). Comma-separated for multiple.
// Optional explicit override of the invoke ARN(s). `bedrockModelArns` is plural
// because the override replaces the ENTIRE derived ARN set — and even a single
// cross-Region model needs several ARNs (profile + per-region foundation
// models), so the value is inherently a list.
const bedrockModelArnsRaw = app.node.tryGetContext('bedrockModelArns');
const bedrockModelArns: string[] | undefined = bedrockModelArnsRaw
  ? String(bedrockModelArnsRaw)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  : undefined;

// Base foundation-model id(s). Drives both ARN derivation and (when enabling
// access automatically) the BootstrapStack agreement path.
//
// `bedrockModelIds` is plural (comma-separated) to reserve the shape for
// multi-model support. The ARN set for each id is derived in code (see
// lib/bedrock-arns.ts), so multi-model only needs to loop over this list — no
// parallel ARN list to keep in sync. EXACTLY ONE entry is supported today;
// passing more fails the deploy (see ENHANCEMENTS.md).
const bedrockModelIdsRaw = app.node.tryGetContext('bedrockModelIds');
const bedrockModelIds: string[] = bedrockModelIdsRaw
  ? String(bedrockModelIdsRaw)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  : [];

if (bedrockModelIds.length > 1) {
  throw new Error(
    `bedrockModelIds currently supports exactly one model, got ` +
      `${bedrockModelIds.length}: ${bedrockModelIds.join(', ')}. ` +
      `Multi-model support is a planned enhancement (see ENHANCEMENTS.md).`,
  );
}
const bedrockModelId = bedrockModelIds[0];

// Need the owner, plus a way to know which model the role may invoke: either the
// base id(s) (preferred — everything derives from them) or an explicit ARN override.
if (!githubOwner || (!bedrockModelId && !bedrockModelArns)) {
  throw new Error(
    'Missing required context. Provide -c githubOwner=<owner> and ' +
      '-c bedrockModelIds=<base-model-id> (recommended), or ' +
      '-c bedrockModelArns=<arn> to set the invoke ARN(s) explicitly (see README).',
  );
}

// Region/account come from the usual CDK environment variables.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

new ReviewerRoleStack(app, 'StrandshipRoleStack', {
  githubOwner,
  githubRepo,
  bedrockModelId,
  bedrockModelArns,
  inferenceProfilePrefix,
  createOidcProvider,
  env,
});

// Optional: automate Bedrock model-access enablement. Only created when a base
// model id is supplied. ⚠️ For third-party models this ACCEPTS the model EULA in
// your account on deploy — see the README.
if (bedrockModelId) {
  new BootstrapStack(app, 'StrandshipBootstrapStack', {
    bedrockModelId,
    env,
  });
}
