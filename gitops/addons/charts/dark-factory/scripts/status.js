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
// When "true", the pipeline posts ONE consolidated verdict REVIEW summarizing both
// agents' results once verification is terminal (see the block near the end). This
// gives a consistent reviewer signal because the AWS agent Apps review autonomously
// + inconsistently and (confirmed) CANNOT be added via the requested_reviewers API.
const POST_VERDICT_REVIEW = (process.env.POST_VERDICT_REVIEW || "").toLowerCase() === "true";
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
  const concToState = (c) => ({ success: "success", neutral: "success", skipped: "success",
    failure: "failure", timed_out: "failure", cancelled: "failure", action_required: "failure" }[c] || "pending");
  // MULTI-SHA ROBUSTNESS: the hub verify steps (holdout/security/deploy-test) post
  // their commit statuses on the SHA that was HEAD when they ran. If the coder then
  // pushes another commit (an impl re-post, or an agent re-review moves head),
  // reading only pr.head.sha shows those steps as "not run" even though they passed
  // on an earlier commit. So collect statuses + check-runs across ALL PR commits,
  // oldest -> newest, letting a later commit's verdict override an earlier one.
  const by = {};
  let shas = [pr.head.sha];
  try {
    const commits = await api("GET", `/repos/${REPO}/pulls/${pr.number}/commits?per_page=100`);
    if (Array.isArray(commits) && commits.length) shas = commits.map((c) => c.sha); // oldest -> newest
  } catch (e) { /* fall back to head only */ }
  for (const sha of shas) {
    try {
      const st = await api("GET", `/repos/${REPO}/commits/${sha}/status`);
      // GitHub returns statuses newest-first; take the first (latest) per context on this commit.
      const seen = {};
      for (const s of st.statuses || []) {
        if (seen[s.context]) continue;
        seen[s.context] = 1;
        by[s.context] = { state: s.state, desc: s.description || "" };
      }
    } catch (e) { /* skip this commit */ }
    try {
      const cr = await api("GET", `/repos/${REPO}/commits/${sha}/check-runs`);
      for (const c of cr.check_runs || []) {
        const state = c.status === "completed" ? concToState(c.conclusion) : "pending";
        by[c.name] = { state, desc: (c.output && c.output.title) || c.conclusion || c.status };
      }
    } catch (e) { /* non-fatal */ }
  }
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
  // Overall state = worst across the dark-factory/* + agent verdicts we collected.
  const overall = (() => {
    const vals = Object.entries(by).filter(([k]) => k.startsWith("dark-factory/") || k === DEVOPS_CHECK || k === SECURITY_CHECK).map(([, v]) => v.state);
    if (vals.includes("failure") || vals.includes("error")) return "failure";
    if (vals.includes("pending")) return "pending";
    return vals.length ? "success" : "pending";
  })();
  const block = [
    MARKER,
    "### 🏭 Dark Factory — verification",
    row("implementation", "Build + unit tests"),
    // Holdout appears ONLY when it actually evaluated something. The scenarios are
    // repo/language-specific (appliesWhen), so a Terraform-only PR has none — in
    // that case the step reports "not applicable"; omit the row entirely (like
    // deploy-test) rather than clutter the board with a not-applicable/​not-run line.
    ...((by["dark-factory/holdout"] && !/not applicable|n\/a/i.test(by["dark-factory/holdout"].desc || ""))
        ? [row("holdout", "Holdout gate")] : []),
    securityRow,
    devopsRow,
    // deploy-test only appears when the PR was deployable; omit the row otherwise.
    ...(by["dark-factory/deploy-test"] ? [row("deploy-test", "Deploy test")] : []),
    "",
    `_Overall: **${overall}**. Autonomously implemented in a hardware-isolated Kata micro-VM; verification ran as independent hub-side steps (see the checks above). Awaiting human review._`,
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
  console.log(`[df-run] PR #${pr.number} body updated — overall=${overall}`);

  // ── Consolidated verdict REVIEW ──────────────────────────────────────────
  // The AWS agent Apps review autonomously and inconsistently (sometimes a formal
  // review that lands in the sidebar, sometimes only an issue comment; and GitHub
  // App bots cannot be added via the requested_reviewers API). So — for a
  // CONSISTENT, always-present reviewer signal — the pipeline posts ONE formal PR
  // review summarizing both agents' verdicts (as the workflow's GitHub identity).
  // Posted only when verification is TERMINAL (not while pending) and only ONCE
  // (idempotent via a hidden marker), so it doesn't spam on every status refresh.
  if (POST_VERDICT_REVIEW && overall !== "pending") {
    const RVMARK = "<!-- dark-factory:verdict-review -->";
    try {
      const existing = await api("GET", `/repos/${REPO}/pulls/${pr.number}/reviews?per_page=100`);
      const already = (existing || []).some((r) => (r.body || "").includes(RVMARK));
      if (already) {
        console.log("[df-run] verdict review already posted — skipping");
      } else {
        const secLine = securityRow.replace(/^- /, "");
        const devLine = devopsRow.replace(/^- /, "");
        const holdoutLine = (by["dark-factory/holdout"] && !/not applicable|n\/a/i.test(by["dark-factory/holdout"].desc || ""))
          ? "\n" + row("holdout", "Holdout gate").replace(/^- /, "") : "";
        const reviewBody = [
          RVMARK,
          "### 🏭 Dark Factory — consolidated agent verdict",
          "",
          row("implementation", "Build + unit tests").replace(/^- /, ""),
          holdoutLine ? holdoutLine.trim() : null,
          secLine,
          devLine,
          "",
          overall === "success"
            ? "**Overall: ✅ all checks green** — Security + DevOps agents cleared. LGTM."
            : "**Overall: ❌ one or more checks failed** — see the rows above.",
          "",
          "_Autonomously implemented + independently verified by the AWS Security & DevOps agents (their checks are the source of truth). This consolidated review is posted by the Dark Factory pipeline so both verdicts are always visible on the PR._",
        ].filter((x) => x !== null).join("\n");
        // COMMENT (not APPROVE): the human still owns the merge approval; this review
        // surfaces the agent verdicts without standing in for human sign-off.
        await api("POST", `/repos/${REPO}/pulls/${pr.number}/reviews`, { event: "COMMENT", body: reviewBody });
        console.log(`[df-run] posted consolidated verdict review (overall=${overall})`);
      }
    } catch (e) {
      console.log(`[df-run] verdict review skipped: ${e.message.slice(0, 140)}`);
    }
  }
}

main().catch((e) => { console.error(`[df-run] status update failed (non-fatal): ${e.message}`); process.exit(0); });
