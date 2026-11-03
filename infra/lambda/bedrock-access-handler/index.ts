/**
 * Custom-resource handler that enables Amazon Bedrock model access, branching on
 * the model's provider to pick the correct agreement path:
 *
 *   amazon.*     -> native first-party model; NO agreement needed. We only verify
 *                   availability (and surface a clear error if the console-level
 *                   access toggle is still required / the model isn't available).
 *   anthropic.*  -> third-party model requiring (a) a one-time per-account use-case
 *                   form (PutUseCaseForModelAccess) AND (b) CreateFoundationModelAgreement.
 *   <other>.*    -> other third-party (meta, mistral, cohere, ai21, stability, ...):
 *                   CreateFoundationModelAgreement only (no use-case form).
 *
 * The handler is IDEMPOTENT: it checks GetFoundationModelAvailability first and
 * short-circuits if the model is already AVAILABLE. After creating an agreement it
 * POLLS availability until AVAILABLE (PENDING is expected, especially for Anthropic)
 * or a timeout is hit.
 *
 * IMPORTANT: Creating a third-party agreement constitutes acceptance of that model's
 * End User License Agreement (EULA) on the deploying account's behalf. This is a
 * deliberate, documented side effect of deploying the BootstrapStack.
 *
 * The model id passed here is the BASE foundation-model id (e.g.
 * "anthropic.claude-sonnet-4-20250514-v1:0"), NOT the "us."-prefixed inference
 * profile used at invocation time. Agreements are granted on the base model.
 */

import {
  BedrockClient,
  GetFoundationModelAvailabilityCommand,
  ListFoundationModelAgreementOffersCommand,
  CreateFoundationModelAgreementCommand,
  PutUseCaseForModelAccessCommand,
} from '@aws-sdk/client-bedrock';

// --- CloudFormation custom-resource event/response types (minimal) ------------

interface CfnEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResourceProperties: Record<string, string>;
  OldResourceProperties?: Record<string, string>;
  PhysicalResourceId?: string;
}

interface HandlerResult {
  PhysicalResourceId: string;
  Data?: Record<string, string>;
}

type Provider = 'amazon' | 'anthropic' | 'thirdparty';

const POLL_TIMEOUT_MS = 9 * 60 * 1000; // leave headroom under the 15-min Lambda cap
const POLL_INTERVAL_MS = 15 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Derive the provider class from the model id's prefix. */
function providerOf(modelId: string): Provider {
  const prefix = modelId.split('.')[0]?.toLowerCase();
  if (prefix === 'amazon') return 'amazon';
  if (prefix === 'anthropic') return 'anthropic';
  return 'thirdparty';
}

/** Stable, model-scoped physical id so a model change forces a replacement. */
function physicalId(modelId: string, region: string): string {
  return `bedrock-access:${region}:${modelId}`;
}

async function getStatus(
  client: BedrockClient,
  modelId: string,
): Promise<string | undefined> {
  const resp = await client.send(
    new GetFoundationModelAvailabilityCommand({ modelId }),
  );
  return resp.agreementAvailability?.status;
}

async function pollUntilAvailable(
  client: BedrockClient,
  modelId: string,
): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const status = await getStatus(client, modelId);
    if (status === 'AVAILABLE') return;
    if (status === 'ERROR') {
      throw new Error(
        `Model ${modelId} agreement entered ERROR state; cannot enable access.`,
      );
    }
    if (status === 'NOT_AVAILABLE') {
      // For a model we just created an agreement for, NOT_AVAILABLE after a short
      // wait usually means the model isn't offered in this region/account.
      if (Date.now() > deadline) {
        throw new Error(
          `Model ${modelId} is NOT_AVAILABLE in this region/account after waiting. ` +
            `Check that the model is offered in your region.`,
        );
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for model ${modelId} to become AVAILABLE ` +
          `(last status: ${status ?? 'unknown'}). Anthropic agreements can sit in ` +
          `PENDING; re-running the deploy may resolve it.`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Submit the one-time Anthropic use-case form. Safe to call repeatedly. */
async function putAnthropicUseCase(
  client: BedrockClient,
  props: Record<string, string>,
): Promise<void> {
  const formData = JSON.stringify({
    companyName: props.companyName || 'Personal',
    companyWebsite: props.companyWebsite || 'https://example.com',
    intendedUsers: props.intendedUsers || '0', // 0=Internal,1=External,2=Both
    industryOption: props.industryOption || 'Technology',
    otherIndustryOption: props.otherIndustryOption || '',
    useCases:
      props.useCases || 'Automated pull-request code review on GitHub repositories.',
  });
  // The SDK's formData field is a blob (Uint8Array). Pass the raw UTF-8 JSON
  // bytes — the SDK handles base64 wire-encoding itself. (The AWS CLI, by
  // contrast, wants a pre-base64-encoded string; the SDK does not.)
  const formBytes = new TextEncoder().encode(formData);
  await client.send(new PutUseCaseForModelAccessCommand({ formData: formBytes }));
}

async function createAgreement(
  client: BedrockClient,
  modelId: string,
): Promise<void> {
  const offers = await client.send(
    new ListFoundationModelAgreementOffersCommand({ modelId, offerType: 'ALL' }),
  );
  const offerToken = offers.offers?.[0]?.offerToken;
  if (!offerToken) {
    throw new Error(
      `No agreement offer found for model ${modelId}. It may not be available in ` +
        `this region, or it may not require an agreement.`,
    );
  }
  await client.send(
    new CreateFoundationModelAgreementCommand({ modelId, offerToken }),
  );
}

/** Enable access for one model according to its provider path. Idempotent. */
async function enableModel(
  region: string,
  modelId: string,
  props: Record<string, string>,
): Promise<void> {
  const client = new BedrockClient({ region });
  const provider = providerOf(modelId);

  // Idempotency: if already available, do nothing (any provider).
  const initial = await getStatus(client, modelId);
  if (initial === 'AVAILABLE') {
    console.log(`Model ${modelId} already AVAILABLE; nothing to do.`);
    return;
  }

  if (provider === 'amazon') {
    // First-party: no agreement to create. If it isn't AVAILABLE, the account
    // still needs the (console) model-access grant, which this API can't perform.
    throw new Error(
      `Amazon model ${modelId} is not AVAILABLE and native models have no ` +
        `programmatic agreement path. Enable it once via the Bedrock console ` +
        `(Model access), then re-deploy. Current status: ${initial ?? 'unknown'}.`,
    );
  }

  if (provider === 'anthropic') {
    // One-time per-account use-case form, then the agreement.
    console.log(`Submitting Anthropic use-case form for ${modelId}...`);
    await putAnthropicUseCase(client, props);
  }

  console.log(`Creating foundation-model agreement for ${modelId}...`);
  await createAgreement(client, modelId);

  console.log(`Polling until ${modelId} is AVAILABLE...`);
  await pollUntilAvailable(client, modelId);
  console.log(`Model ${modelId} is now AVAILABLE.`);
}

export async function handler(event: CfnEvent): Promise<HandlerResult> {
  const region = event.ResourceProperties.region;
  const modelId = event.ResourceProperties.modelId;
  const pid = physicalId(modelId, region);

  console.log(`${event.RequestType} for model=${modelId} region=${region}`);

  // On Delete we intentionally do NOT tear down the agreement: model access is an
  // account-level concern that likely outlives this stack, and deleting it would
  // disrupt anything else using the model. (Re-creating it is cheap/idempotent.)
  if (event.RequestType === 'Delete') {
    console.log('Delete: leaving model agreement in place (no-op).');
    return { PhysicalResourceId: event.PhysicalResourceId ?? pid };
  }

  await enableModel(region, modelId, event.ResourceProperties);

  return {
    PhysicalResourceId: pid,
    Data: { modelId, region, provider: providerOf(modelId) },
  };
}
