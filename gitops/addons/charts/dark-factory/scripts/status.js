// status.js — the Dark Factory "one live sticky status" (README §7). Runs in the
// hub-side sticky-status step AFTER every verify step. The coder wrote the PR body
// at PR-open time (before verification ran), so its holdout/security/devops lines
// are placeholders. This reads the authoritative dark-factory/* commit STATUSES
// from GitHub (what the verify steps posted) and rewrites the PR body's marker
// block in place with the real verdicts. Idempotent; non-fatal on error.
//
// Env: GH_TOKEN, REPO (owner/name), BRANCH (df/issue-N).
//   DEVOPS_CHECK (optional) real AWS DevOps Agent check-run name (Checks API), e.g.
//                aws-devops-agent/release-readiness-review. The DevOps row reads it
//                from check-runs (not commit statuses) so the real verdict shows.
//   SECURITY_CHECK (optional) real AWS Security Agent GitHub App check-run name.
//                When present on the PR, the Security row shows the App's inline-bot
//                verdict; otherwise it falls back to our headless dark-factory/security.
const https = require("https");
const { GH_TOKEN, REPO, BRANCH } = process.env;
const DEVOPS_CHECK = process.env.DEVOPS_CHECK || "";
const SECURITY_CHECK = process.env.SECURITY_CHECK || "";
const H = { "User-Agent": "dark-factory-status", Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" };

function api(method, path, body) {
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: "api.github.com", method, path, headers: { ...H, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } },
      (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => {
        if (r.statusCode >= 200 && r.statusCode < 300) resolve(b ? JSON.parse(b) : {});
        else reject(new Error(`${method} ${path} -> ${r.statusCode}: ${b.slice(0, 150)}`));
      }); });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const MARKER = "<!-- dark-factory:status -->";
const icon = (s) => (s === "success" ? "✅" : s === "failure" || s === "error" ? "❌" : s === "pending" ? "⏳" : "⬜");

async function main() {
  const owner = REPO.split("/")[0];
  const prs = await api("GET", `/repos/${REPO}/pulls?head=${owner}:${BRANCH}&state=open`);
  if (!prs.length) { console.log("[df-run] no open PR — nothing to update"); return; }
  const pr = prs[0];
  const st = await api("GET", `/repos/${REPO}/commits/${pr.head.sha}/status`);
  const by = {};
  for (const s of st.statuses || []) if (!by[s.context]) by[s.context] = { state: s.state, desc: s.description || "" };
  // Also fold in check-runs (the real DevOps Agent posts a check-run, not a status).
  const concToState = (c) => ({ success: "success", neutral: "success", skipped: "success",
    failure: "failure", timed_out: "failure", cancelled: "failure", action_required: "failure" }[c] || "pending");
  try {
    const cr = await api("GET", `/repos/${REPO}/commits/${pr.head.sha}/check-runs`);
    for (const c of cr.check_runs || []) {
      const state = c.status === "completed" ? concToState(c.conclusion) : "pending";
      if (!by[c.name]) by[c.name] = { state, desc: (c.output && c.output.title) || c.conclusion || c.status };
    }
  } catch (e) { /* non-fatal — statuses still render */ }
  const row = (ctx, label) => {
    const s = by[ctx.includes("/") ? ctx : `dark-factory/${ctx}`];
    if (!s) return `- ⬜ **${label}:** _not run_`;
    // A step can report success but be "not applicable" to this change (e.g. the
    // holdout gate when no hidden scenario matches a Terraform-only PR). Render
    // that as a neutral ⬜ n/a, not a green ✅ that would imply it actually ran.
    const na = /not applicable|n\/a/i.test(s.desc || "");
    const mark = na ? "⬜" : icon(s.state);
    return `- ${mark} **${label}:** ${s.desc || s.state}`;
  };
  // DevOps row: prefer the real DevOps Agent check-run if configured, else the
  // dark-factory/devops status (label-mode / coder-plugin path).
  const devopsRow = DEVOPS_CHECK && by[DEVOPS_CHECK]
    ? `- ${icon(by[DEVOPS_CHECK].state)} **DevOps review (AWS DevOps Agent):** ${by[DEVOPS_CHECK].desc || by[DEVOPS_CHECK].state}`
    : row("devops", "DevOps review (AWS DevOps Agent)");
  // Security row: prefer the real Security Agent GitHub App check-run (inline-bot
  // review) when present; else fall back to our headless dark-factory/security
  // relayed status. Both paths run — the App is the richer signal when installed.
  const securityRow = SECURITY_CHECK && by[SECURITY_CHECK]
    ? `- ${icon(by[SECURITY_CHECK].state)} **Security review (AWS Security Agent):** ${by[SECURITY_CHECK].desc || by[SECURITY_CHECK].state}`
    : row("security", "Security review (AWS Security Agent)");
  const block = [
    MARKER,
    "### 🏭 Dark Factory — verification",
    row("implementation", "Build + unit tests"),
    row("holdout", "Holdout gate"),
    securityRow,
    devopsRow,
    // deploy-test only appears when the PR was deployable; omit the row otherwise
    // so non-deployable PRs don't show a confusing "not run" line.
    ...(by["dark-factory/deploy-test"] ? [row("deploy-test", "Deploy test")] : []),
    "",
    `_Overall: **${st.state}**. Autonomously implemented in a hardware-isolated Kata micro-VM; verification ran as independent hub-side steps (see the checks above). Awaiting human review._`,
  ].join("\n");

  let body = pr.body || "";
  if (body.includes(MARKER)) {
    body = body.slice(0, body.indexOf(MARKER)).trimEnd();
    body = (body ? body + "\n\n" : "") + block;
  } else {
    body = body.trimEnd();
    body = (body ? body + "\n\n" : "") + block;
  }
  await api("PATCH", `/repos/${REPO}/pulls/${pr.number}`, { body });
  console.log(`[df-run] PR #${pr.number} body updated — overall=${st.state}`);
}

main().catch((e) => { console.error(`[df-run] status update failed (non-fatal): ${e.message}`); process.exit(0); });
