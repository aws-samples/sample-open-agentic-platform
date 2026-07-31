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
        by[s.context] = { state: s.state, desc: s.description || "", url: s.target_url || "" };
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

  // ── THE REAL AWS AGENTS ARE THE SOURCE OF TRUTH ──────────────────────────────
  // Both agents run TWICE on a PR and the copies can DISAGREE: the GitHub App bots
  // (aws-security-agent[bot], aws-devops-agent-*[bot]) review the PR directly, while
  // our hub-side steps drive the SAME agents headlessly + post dark-factory/* commit
  // statuses. The headless copy has been observed to miss findings the App bot caught
  // (e.g. a wildcard-ARN IAM policy) — so trusting the headless status produced a
  // FALSE "no findings / LGTM" next to a bot review listing real findings. Fix: the
  // consolidation reads the AGENT BOTS' OWN reviews as authoritative. The headless
  // dark-factory/* statuses are demoted to a fallback ONLY when a bot didn't post.
  //
  // The bots post a formal REVIEW (state COMMENTED) whose body begins with a summary,
  // plus INLINE review comments per finding. They do NOT emit a check-run for findings
  // and never use CHANGES_REQUESTED, so we parse the review body + count inline
  // comments rather than reading a state flag.
  const reviews = (await api("GET", `/repos/${REPO}/pulls/${pr.number}/reviews?per_page=100`).catch(() => [])) || [];
  const prComments = (await api("GET", `/repos/${REPO}/pulls/${pr.number}/comments?per_page=100`).catch(() => [])) || [];
  const latestBotReview = (pred) => (reviews.filter((r) => pred((r.user || {}).login || "")).slice(-1)[0]) || null;
  const inlineCountBy = (pred) => prComments.filter((c) => pred((c.user || {}).login || "")).length;
  const isSecBot = (l) => /^aws-security-agent(\[bot\]|-.*\[bot\])?$/i.test(l) || /security-agent/i.test(l) && /\[bot\]/i.test(l);
  const isDevBot = (l) => /aws-devops-agent/i.test(l) && /\[bot\]/i.test(l);

  // Parse an agent bot review body into {state, desc}. A body that reports one or
  // more findings → failure; an explicit "no findings / no issues" → success; a bot
  // that only said it's "reviewing…" (no verdict yet) → pending.
  const parseAgentVerdict = (body, inlineFindings) => {
    const b = (body || "").toLowerCase();
    const m = b.match(/(\d+)\s+(?:medium|high|low|critical|informational)?[- ]?severity?\s*finding/) ||
              b.match(/identified\s+\*{0,2}(\d+)\b[^.]*finding/) || b.match(/\b(\d+)\s+finding/);
    const declaredNum = m ? parseInt(m[1], 10) : null;
    const saysClean = /no (issues identified|findings|security issues)|no issues were|looks good|lgtm/i.test(body || "");
    const stillReviewing = /is reviewing|will post feedback|analysis in progress/i.test(body || "") && declaredNum === null && !saysClean;
    const n = declaredNum !== null ? declaredNum : (inlineFindings > 0 ? inlineFindings : 0);
    if (stillReviewing) return { state: "pending", desc: "review in progress", n: null };
    if (n > 0) return { state: "failure", desc: `${n} finding(s) — changes requested`, n };
    if (saysClean || (declaredNum === 0)) return { state: "success", desc: "no findings", n: 0 };
    // A bot review with a body we couldn't classify + inline comments = treat as findings.
    if (inlineFindings > 0) return { state: "failure", desc: `${inlineFindings} finding(s) — changes requested`, n: inlineFindings };
    return null; // no usable bot signal
  };

  // Security: prefer the App bot's review; else its configured check; else headless status.
  const secBotReview = latestBotReview(isSecBot);
  const secBotInline = inlineCountBy(isSecBot);
  const secBot = secBotReview ? parseAgentVerdict(secBotReview.body, secBotInline) : null;
  const secResolved = secBot
    || (SECURITY_CHECK && by[SECURITY_CHECK] ? { state: by[SECURITY_CHECK].state, desc: by[SECURITY_CHECK].desc || by[SECURITY_CHECK].state } : null)
    || (by["dark-factory/security"] ? { state: by["dark-factory/security"].state, desc: by["dark-factory/security"].desc || by["dark-factory/security"].state } : null);
  const securityRow = secResolved
    ? `- ${icon(secResolved.state)} **Security review (AWS Security Agent):** ${secResolved.desc}${secBot ? " _(agent review)_" : ""}`
    : `- ⬜ **Security review (AWS Security Agent):** _not run_`;

  // DevOps: the App bot's release-readiness verdict lives in its commit STATUS/check
  // (change approved / BLOCK / proceed-with-caution) — that IS the real bot. But it
  // also posts inline review comments; if the status says "approved" yet the bot left
  // change-requesting inline comments, surface that (do not silently call it clean).
  const devBotStatus = (DEVOPS_CHECK && by[DEVOPS_CHECK]) ? by[DEVOPS_CHECK] : by["dark-factory/devops"];
  const devInline = inlineCountBy(isDevBot);
  const devBlockedByStatus = devBotStatus && (devBotStatus.state === "failure" || /block|not (safe|ready)|changes? requested/i.test(devBotStatus.desc || ""));
  const devResolved = devBotStatus
    ? { state: devBlockedByStatus ? "failure" : devBotStatus.state, desc: devBotStatus.desc || devBotStatus.state, url: devBotStatus.url || "" }
    : null;
  // Surface the DevOps Agent's full release-readiness report link (target_url) so
  // reviewers can open the assessment, plus a count of its inline comments.
  const devopsRow = devResolved
    ? `- ${icon(devResolved.state)} **DevOps review (AWS DevOps Agent):** ${devResolved.desc}` +
      (devResolved.url ? ` — [view report ↗](${devResolved.url})` : "") +
      (devInline ? ` _(+${devInline} inline comment(s))_` : "")
    : `- ⬜ **DevOps review (AWS DevOps Agent):** _not run_`;

  // Overall = worst across build/holdout + the RESOLVED agent verdicts (bot-first).
  const overall = (() => {
    const vals = [
      (by["dark-factory/implementation"] || {}).state,
      // holdout only counts when it actually evaluated (not n/a)
      (by["dark-factory/holdout"] && !/not applicable|n\/a/i.test(by["dark-factory/holdout"].desc || "")) ? by["dark-factory/holdout"].state : undefined,
      secResolved ? secResolved.state : undefined,
      devResolved ? devResolved.state : undefined,
    ].filter((v) => v !== undefined);
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
  //
  // Gate: post once the steps the WORKFLOW controls are resolved (implementation +
  // security). We deliberately do NOT wait for `overall` to be non-pending, because
  // the DevOps Agent App reviews ASYNCHRONOUSLY and its check is often still PENDING
  // when sticky-status runs (at workflow end) — and sticky-status runs only ONCE, so
  // gating on it would mean the review never posts. A still-pending DevOps verdict is
  // shown as "in progress" in the review body. Idempotent via a hidden marker.
  const implState = (by["dark-factory/implementation"] || {}).state;
  // Ready once build is done and the Security agent has a verdict (its findings are
  // the strict gate). DevOps may still be async-pending — shown as "in progress".
  const secState = secResolved ? secResolved.state : undefined;
  const readyToReview = implState && implState !== "pending" && (!secState || secState !== "pending");
  if (POST_VERDICT_REVIEW && readyToReview) {
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
        // Build a plain-English findings summary from whichever agents flagged issues.
        const flagged = [];
        if (secResolved && secResolved.state === "failure") flagged.push(`Security (${secResolved.desc})`);
        if (devResolved && devResolved.state === "failure") flagged.push(`DevOps (${devResolved.desc})`);
        const verdictLine =
          overall === "failure"
            ? `**Overall: ❌ Changes requested — do NOT merge.** ${flagged.length ? flagged.join(" and ") + " flagged issues" : "One or more checks failed"}. Address the agents' findings (see their inline review comments), push a fix, and the pipeline re-evaluates. This is NOT approved.`
            : overall === "pending"
              ? "**Overall: ⏳ Security cleared; DevOps review still in progress** — final verdict pending the DevOps release-readiness review. Not yet approved."
              : "**Overall: ✅ All checks green** — Build, Holdout, Security, and DevOps agents all cleared with no findings. Looks good to merge (human approval still required).";
        const reviewBody = [
          RVMARK,
          "### 🏭 Dark Factory — consolidated agent verdict",
          "",
          row("implementation", "Build + unit tests").replace(/^- /, ""),
          holdoutLine ? holdoutLine.trim() : null,
          secLine,
          devLine,
          "",
          verdictLine,
          "",
          "_The AWS Security & DevOps agents' own reviews are the source of truth; this consolidated review reads their verdicts (findings block the merge) so both are always visible in one place. Posted by the Dark Factory pipeline as a COMMENT — a human still owns the merge decision._",
        ].filter((x) => x !== null).join("\n");
        // Event: REQUEST_CHANGES when an agent flagged findings (so the PR visibly
        // shows changes-requested, not a bland comment); COMMENT otherwise. Never
        // APPROVE — the human owns merge approval. If REQUEST_CHANGES is rejected
        // (e.g. can't request changes on own PR in some setups), fall back to COMMENT.
        const event = overall === "failure" ? "REQUEST_CHANGES" : "COMMENT";
        try {
          await api("POST", `/repos/${REPO}/pulls/${pr.number}/reviews`, { event, body: reviewBody });
        } catch (e) {
          await api("POST", `/repos/${REPO}/pulls/${pr.number}/reviews`, { event: "COMMENT", body: reviewBody });
        }
        console.log(`[df-run] posted consolidated verdict review (event=${event}, overall=${overall})`);
      }
    } catch (e) {
      console.log(`[df-run] verdict review skipped: ${e.message.slice(0, 140)}`);
    }
  }
}

main().catch((e) => { console.error(`[df-run] status update failed (non-fatal): ${e.message}`); process.exit(0); });
