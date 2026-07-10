// k8s.js — Sandbox lifecycle against the Flow A warm pool.
//
// The orchestrator claims a pre-warmed Kata micro-VM from the agent-sandbox
// SandboxWarmPool (Flow A) via a SandboxClaim keyed on the GitHub issue id,
// waits for it to bind + become Ready, then tears it down on merge. This is
// the Flow B adaptation of the openclaw session-router: keyed on issue-id
// instead of a Cognito sub, and it binds a warm sandbox instead of creating a
// per-user Sandbox/PVC/Service.
//
// CRD facts (verified against the live v1beta1 CRDs on spoke-dev):
//   group/version : extensions.agents.x-k8s.io/v1beta1
//   SandboxClaim.spec   : warmPoolRef.name, env[]{containerName,name,value},
//                         lifecycle{ttlSecondsAfterFinished,...}
//   SandboxClaim.status : sandbox{name, podIPs[]}, conditions[]
const k8s = require("@kubernetes/client-node");

const GROUP = "extensions.agents.x-k8s.io";
const VERSION = "v1beta1";
const CLAIM_PLURAL = "sandboxclaims";

const NAMESPACE = process.env.SANDBOX_NAMESPACE || "agent-sandbox-system";
const WARM_POOL = process.env.WARM_POOL_NAME || "coder-warmpool";
const CLAIM_READY_TIMEOUT_MS = parseInt(
  process.env.CLAIM_READY_TIMEOUT_MS || "120000",
  10,
);
// Hard TTL so a crashed/abandoned run's sandbox is reclaimed even if teardown
// never runs (the reaper is the other half of this safety net).
const CLAIM_TTL_SECONDS = parseInt(
  process.env.CLAIM_TTL_SECONDS || "10800",
  10,
);

const kc = new k8s.KubeConfig();
kc.loadFromDefault(); // in-cluster SA when deployed; kubeconfig locally.
const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

// Retry with capped exponential backoff — the operator/apiserver can be
// briefly unavailable during a warm-pool refill.
async function withRetry(label, fn, { attempts = 4, baseMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === attempts - 1) throw e;
      const wait = baseMs * Math.pow(2, i);
      console.warn(
        `[k8s] ${label} failed (attempt ${i + 1}/${attempts}): ` +
          `${e?.body?.message || e?.message || e}; retry in ${wait}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// Deterministic claim name per issue so re-delivered webhooks are idempotent
// (a second trigger for the same issue binds to the existing claim).
function claimName(issueId) {
  return `df-issue-${String(issueId).replace(/[^a-z0-9-]/gi, "").toLowerCase()}`;
}

function buildClaim(issueId, env = []) {
  return {
    apiVersion: `${GROUP}/${VERSION}`,
    kind: "SandboxClaim",
    metadata: {
      name: claimName(issueId),
      namespace: NAMESPACE,
      labels: {
        "dark-factory.io/managed-by": "orchestrator",
        "dark-factory.io/issue": String(issueId),
      },
    },
    spec: {
      warmPoolRef: { name: WARM_POOL },
      // Per-container env the coder reads (BIFROST_URL, CODER_PROFILE, etc.).
      // Secrets are NOT passed here — they arrive via projected tmpfs.
      env: env.map((e) => ({
        containerName: e.containerName || "coder",
        name: e.name,
        value: String(e.value),
      })),
      lifecycle: { ttlSecondsAfterFinished: CLAIM_TTL_SECONDS },
    },
  };
}

// Claim a warm sandbox (idempotent). Returns the created/existing claim object.
async function claimSandbox(issueId, env) {
  const name = claimName(issueId);
  try {
    const existing = await withRetry("claim get", () =>
      customApi.getNamespacedCustomObject(
        GROUP,
        VERSION,
        NAMESPACE,
        CLAIM_PLURAL,
        name,
      ),
    );
    console.log(`[k8s] claim ${name} already exists — reusing`);
    return existing.body;
  } catch (e) {
    if (e?.statusCode !== 404) throw e;
  }
  const created = await withRetry("claim create", () =>
    customApi.createNamespacedCustomObject(
      GROUP,
      VERSION,
      NAMESPACE,
      CLAIM_PLURAL,
      buildClaim(issueId, env),
    ),
  );
  console.log(`[k8s] SandboxClaim ${name} created (warmPoolRef=${WARM_POOL})`);
  return created.body;
}

function isReady(claim) {
  const conds = claim?.status?.conditions || [];
  return conds.some((c) => c.type === "Ready" && c.status === "True");
}

// Poll the claim until the operator binds a warm sandbox and reports Ready.
// Returns { name, podIPs } of the bound sandbox.
async function waitForClaimBound(issueId, deadlineMs = CLAIM_READY_TIMEOUT_MS) {
  const name = claimName(issueId);
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const { body: claim } = await customApi.getNamespacedCustomObject(
      GROUP,
      VERSION,
      NAMESPACE,
      CLAIM_PLURAL,
      name,
    );
    const bound = claim?.status?.sandbox?.name;
    if (bound && isReady(claim)) {
      return {
        name: bound,
        podIPs: claim.status.sandbox.podIPs || [],
      };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `SandboxClaim ${name} not Ready within ${deadlineMs}ms ` +
      `(warm pool exhausted or sandbox failed to start?)`,
  );
}

// Teardown — delete the claim; the operator releases the sandbox back / reaps
// it and the warm pool refills. Idempotent (404 is success).
async function releaseSandbox(issueId) {
  const name = claimName(issueId);
  try {
    await withRetry("claim delete", () =>
      customApi.deleteNamespacedCustomObject(
        GROUP,
        VERSION,
        NAMESPACE,
        CLAIM_PLURAL,
        name,
      ),
    );
    console.log(`[k8s] SandboxClaim ${name} deleted (sandbox released)`);
  } catch (e) {
    if (e?.statusCode === 404) return;
    throw e;
  }
}

module.exports = {
  NAMESPACE,
  WARM_POOL,
  claimName,
  claimSandbox,
  waitForClaimBound,
  releaseSandbox,
  withRetry,
};
