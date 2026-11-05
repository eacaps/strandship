/**
 * Helpers to derive the Bedrock ARNs a cross-Region inference profile needs,
 * from a BASE foundation-model id (e.g. "anthropic.claude-sonnet-5-5")
 * plus the deploy region/account.
 *
 * Why a set of ARNs, not one: when you invoke via a cross-Region inference
 * profile (the "us."/"eu."/"apac."-prefixed id), Bedrock may route the call to
 * the underlying foundation model in ANY region the profile spans. Amazon
 * Bedrock therefore requires the invoke policy to grant BOTH:
 *   - the inference-profile ARN, and
 *   - the foundation-model ARN in EACH region the profile spans.
 * Granting only one ARN causes runtime AccessDenied when Bedrock routes
 * cross-Region. See:
 * https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html
 *
 * This is the STATIC derivation (no AWS API calls at synth time): the member
 * regions per geo are a maintained map below. For a profile that doesn't fit
 * these assumptions, pass `bedrockModelArns` explicitly to override.
 */

/** Geographic inference-profile prefixes and the regions each one spans. */
const PROFILE_GEOS: Record<string, { prefix: string; regions: string[] }> = {
  us: {
    prefix: 'us',
    regions: ['us-east-1', 'us-east-2', 'us-west-2'],
  },
  eu: {
    prefix: 'eu',
    regions: ['eu-central-1', 'eu-west-1', 'eu-west-3', 'eu-north-1'],
  },
  apac: {
    prefix: 'apac',
    regions: ['ap-northeast-1', 'ap-northeast-2', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2'],
  },
};

/**
 * Map a deploy region to its inference-profile geo. `us-*` -> us, `eu-*` -> eu,
 * `ap-*` -> apac. Returns undefined for regions we don't have a mapping for
 * (e.g. ca-, sa-, me-), in which case the caller should require an explicit ARN.
 */
export function geoForRegion(region: string): keyof typeof PROFILE_GEOS | undefined {
  if (region.startsWith('us-')) return 'us';
  if (region.startsWith('eu-')) return 'eu';
  if (region.startsWith('ap-')) return 'apac';
  return undefined;
}

export interface DerivedBedrockArns {
  /** The cross-Region inference-profile ARN the agent invokes. */
  readonly inferenceProfileArn: string;
  /** Foundation-model ARNs for every region the profile spans. */
  readonly foundationModelArns: string[];
  /** All ARNs to put in the policy Resource (profile + FMs). */
  readonly all: string[];
}

export interface DeriveOptions {
  /** BASE model id, e.g. "anthropic.claude-sonnet-5-5". */
  readonly modelId: string;
  /** Deploy region (CDK `this.region`). */
  readonly region: string;
  /** Deploy account (CDK `this.account`). */
  readonly account: string;
  /** Override the geo prefix (e.g. force "us"); defaults from `region`. */
  readonly prefix?: string;
}

/**
 * Derive the inference-profile ARN + per-region foundation-model ARNs for a base
 * model id. Throws if the region has no known geo mapping and no prefix override
 * is supplied — callers should fall back to an explicit `bedrockModelArns` there.
 */
export function deriveBedrockArns(opts: DeriveOptions): DerivedBedrockArns {
  const { modelId, region, account } = opts;

  const geoKey = (opts.prefix as keyof typeof PROFILE_GEOS) ?? geoForRegion(region);
  if (!geoKey || !PROFILE_GEOS[geoKey]) {
    throw new Error(
      `Cannot derive a Bedrock inference-profile ARN for region "${region}": ` +
        `no known geo mapping (us/eu/apac). Pass -c bedrockModelArns=<arn> to set ` +
        `it explicitly, or -c inferenceProfilePrefix=<us|eu|apac>.`,
    );
  }

  const geo = PROFILE_GEOS[geoKey];

  // Profile ARN lives in the REQUESTING (deploy) region and includes the account.
  const inferenceProfileArn = `arn:aws:bedrock:${region}:${account}:inference-profile/${geo.prefix}.${modelId}`;

  // Foundation-model ARNs span every region in the geo. FM ARNs have NO account.
  // Ensure the deploy region is included even if the map drifts.
  const regions = Array.from(new Set([region, ...geo.regions]));
  const foundationModelArns = regions.map(
    (r) => `arn:aws:bedrock:${r}::foundation-model/${modelId}`,
  );

  return {
    inferenceProfileArn,
    foundationModelArns,
    all: [inferenceProfileArn, ...foundationModelArns],
  };
}
