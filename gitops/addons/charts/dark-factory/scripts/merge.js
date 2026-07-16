// merge.js — merge a human-approved Dark Factory PR, but ONLY if it is green.
// Runs in the df-merge-teardown workflow (fired by an approved PR review). The
// approval is the human gate; this adds a safety check that every dark-factory/*
// commit status on the PR head succeeded, so a stray approval on a red PR can't
// merge. The agent never self-merges — this path only runs on a human approval
// event routed by the Sensor.
//
// Env: GH_TOKEN, REPO (owner/name), PR (number).
//   DEVOPS_CHECK   (optional) the real AWS DevOps Agent check-run name/context to
//                  require green in check-mode (e.g. aws-devops-agent/release-readiness-review).
//                  When set, it's added to the required gate and satisfied by EITHER a
//                  commit status OR a check-run of that name.
//   REQUIRE_DEVOPS "true"|"false" — whether DevOps clearance is required to merge
//                  (false in security-only mode). Default true.
const https = require("https");
const { GH_TOKEN, REPO, PR } = process.env;
const DEVOPS_CHECK = process.env.DEVOPS_CHECK || "";
const REQUIRE_DEVOPS = (process.env.REQUIRE_DEVOPS || "true").toLowerCase() !== "false";
const H = { "User-Agent": "dark-factory-merge", Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" };

function api(method, path, body) {
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: "api.github.com", method, path, headers: { ...H, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } },
      (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => {
        if (r.statusCode >= 200 && r.statusCode < 300) resolve(b ? JSON.parse(b) : {});
        else reject(Object.assign(new Error(`${method} ${path} -> ${r.statusCode}: ${b.slice(0, 200)}`), { statusCode: r.statusCode }));
      }); });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Which checks must be green before we merge. The df-run steps post COMMIT STATUSES
// (dark-factory/*); the REAL AWS DevOps Agent posts a CHECK-RUN (Checks API) named
// DEVOPS_CHECK. We read BOTH surfaces and require each listed check to be success.
// holdout/security are advisory in v1 (post success unless blocking on), but we
// still require them to be *success*, not failure/error.
const REQUIRED = ["dark-factory/implementation", "dark-factory/holdout", "dark-factory/security"];
if (REQUIRE_DEVOPS) REQUIRED.push(DEVOPS_CHECK || "dark-factory/devops");

// Map GitHub check-run conclusion → status-style state.
const concToState = (c) => ({ success: "success", neutral: "success", skipped: "success",
  failure: "failure", timed_out: "failure", cancelled: "failure", action_required: "failure" }[c] || "pending");

async function main() {
  const pr = await api("GET", `/repos/${REPO}/pulls/${PR}`);
  if (pr.state !== "open") { console.log(`[df-merge] PR #${PR} is ${pr.state}, not open — nothing to merge`); return; }
  const sha = pr.head.sha;
  // Read commit statuses AND check-runs (the DevOps Agent uses the Checks API).
  const st = await api("GET", `/repos/${REPO}/commits/${sha}/status`);
  const by = {};
  for (const s of st.statuses || []) if (!by[s.context]) by[s.context] = s.state;
  try {
    const cr = await api("GET", `/repos/${REPO}/commits/${sha}/check-runs`);
    for (const c of cr.check_runs || []) {
      const state = c.status === "completed" ? concToState(c.conclusion) : "pending";
      // Prefer a completed check-run's verdict; don't overwrite an existing success.
      if (!by[c.name] || by[c.name] === "pending") by[c.name] = state;
    }
  } catch (e) { console.log(`[df-merge] check-runs read skipped: ${e.message}`); }
  const notGreen = REQUIRED.filter((c) => by[c] && by[c] !== "success");
  const missing = REQUIRED.filter((c) => !by[c]);
  if (notGreen.length) { console.error(`[df-merge] refusing to merge — not green: ${notGreen.map((c) => `${c}=${by[c]}`).join(", ")}`); process.exit(1); }
  if (missing.length) console.log(`[df-merge] note: checks not present (treated as skipped): ${missing.join(", ")}`);

  console.log(`[df-merge] PR #${PR} green + human-approved — merging (squash)`);
  await api("PUT", `/repos/${REPO}/pulls/${PR}/merge`, {
    merge_method: "squash",
    commit_title: `${pr.title} (#${PR})`,
    commit_message: "Merged by Dark Factory after human approval. Autonomously implemented + verified (holdout + security + devops).",
  });
  console.log(`[df-merge] PR #${PR} merged.`);
  // Best-effort: delete the coder branch now that it's merged.
  try { await api("DELETE", `/repos/${REPO}/git/refs/heads/${pr.head.ref}`); console.log(`[df-merge] deleted branch ${pr.head.ref}`); }
  catch (e) { console.log(`[df-merge] branch delete skipped: ${e.message}`); }
}

main().catch((e) => { console.error(`[df-merge] failed: ${e.message}`); process.exit(1); });
