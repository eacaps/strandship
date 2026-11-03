# Operations — strandship

Operational tasks you run against your **AWS account / GitHub repo** to run and
safeguard the reviewer. These are account/runtime actions, not code changes —
engineering work lives in [`ENHANCEMENTS.md`](./ENHANCEMENTS.md).

---

## Bedrock RPM velocity backstop (abuse / runaway-cost mitigation)

**What:** lower the account's per-minute **requests-per-minute (RPM)** Service Quota
for the reviewer's model + region to its minimum as a cheap, native cap on how fast
Bedrock can be called.

**Why:** the reviewer's cost is **account-wide** — every repo that can assume the role
draws on the same Bedrock quota, so a per-repo limit can't bound it and "spin up
another repo" resets any per-repo counter. Lowering account RPM caps the *velocity*
across all repos at once, bounding the daily worst case at `RPM × 1440` regardless of
how many repos (or PRs) trigger runs. It is the one-step native mitigation against
repo-multiplication abuse.

**How:**
- Console: **Service Quotas → Amazon Bedrock →** find the *requests per minute* quota
  for your model → **Request quota decrease** → set it to the minimum.
- API/CLI: `aws service-quotas request-service-quota-increase` with the model's RPM
  quota code and the target value (the API is used to request either direction).
  Look up the exact quota code in the Service Quotas console for your region first.

**Verify before relying on it (region/model specific):**
- Confirm the model is governed by **RPM** at all. Some models — including Claude
  Sonnet 4 via the `us.`-prefixed inference profile — may be throttled primarily by
  **TPM** (tokens/min), with RPM either absent or not adjustable. Check which quotas
  the model actually exposes in the Service Quotas console.
- Confirm the **minimum**. RPM is (almost certainly) an **integer with a floor of 1** —
  fractional values are not supported — so the lowest achievable ceiling is ~1,440
  requests/day.

**Known limitations — read before setting:**
- **Not a daily budget.** RPM resets every minute, so even at 1 RPM an abuser still
  gets ~1,440 requests/day. This *slows the bleed* and buys time for an alarm to fire;
  it does **not** stop a daily total. For a true "N per day, then stop" cap, see the
  DynamoDB per-day meter in [`ENHANCEMENTS.md`](./ENHANCEMENTS.md).
- **Throttles legitimate reviews too.** The quota is account-wide, so two PRs whose
  reviews land in the same minute at 1 RPM means one gets a `ThrottlingException` and
  that review fails or stalls into the next minute. Fine for a low-volume personal
  project; reconsider the floor for higher-traffic use. (The agent's Bedrock client
  retries on throttling, which softens but does not eliminate this.)

**Related:** pairs with the observability item (CloudWatch `AWS/Bedrock` alarms, AWS
Budget on the tagged inference profile) and the hard per-day meter, both tracked in
[`ENHANCEMENTS.md`](./ENHANCEMENTS.md) under *Spend/abuse controls on the model*.
