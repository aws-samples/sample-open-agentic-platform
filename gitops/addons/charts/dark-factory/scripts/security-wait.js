// security-wait.js — WAIT FOR + MIRROR the real AWS Security Agent bot.
//
// The AWS Security Agent GitHub App (aws-security-agent[bot]) auto-reviews every PR
// and is the SOURCE OF TRUTH for security. This step does NOT run a second scan — it
// polls the bot's own review + inline comments, parses its verdict, and posts it as
// the dark-factory/security commit status so the merge gate + consolidated review key
// off the REAL bot (findings -> failure -> merge blocked). Replaces the old headless
// security-agent.sh, which was a redundant second scan that disagreed with the bot
// (it reported "no findings" while the bot flagged real issues) and produced a false
// "cleared/LGTM". One security signal now: the agent itself.
//
// Env: GH_TOKEN, REPO (owner/name), BRANCH (df/issue-N), POLL_TIMEOUT (seconds),
//   BLOCK_LEVEL (none|low|medium|high|critical) — findings at/above this fail the
//   status (default medium; the bot doesn't expose per-severity counts uniformly, so
//   ANY finding fails unless BLOCK_LEVEL=none, in which case findings are advisory).
const https = require("https");
const { GH_TOKEN, REPO, BRANCH } = process.env;
const POLL_TIMEOUT = parseInt(process.env.POLL_TIMEOUT || "900", 10);
const BLOCK_LEVEL = (process.env.BLOCK_LEVEL || "medium").toLowerCase();
const H = { "User-Agent": "dark-factory-security-wait", Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" };
const CONTEXT = "dark-factory/security";

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
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const isSecBot = (l) => /aws-security-agent/i.test(l || "") && /\[bot\]/i.test(l || "");

// Classify the bot's review body + inline-comment count into a verdict.
//   { done:true, findings:N, desc }  |  { done:false } (still reviewing / not posted)
function classify(reviewBody, inlineCount, sawAck) {
  const body = reviewBody || "";
  const low = body.toLowerCase();
  const m = low.match(/(\d+)\s+(?:medium|high|low|critical|informational)?[- ]?severity?\s*finding/) || low.match(/\b(\d+)\s+finding/);
  const declared = m ? parseInt(m[1], 10) : null;
  const saysClean = /no (issues identified|findings|security issues)|no issues were|looks good/i.test(body);
  if (declared !== null) return { done: true, findings: declared, desc: declared > 0 ? `${declared} finding(s)` : "no findings" };
  if (saysClean) return { done: true, findings: 0, desc: "no findings" };
  if (reviewBody && inlineCount > 0) return { done: true, findings: inlineCount, desc: `${inlineCount} finding(s)` };
  // A bot that ONLY posted "reviewing…"/ack with no verdict body yet → not done.
  return { done: false };
}

async function postStatus(state, description) {
  const prs = await api("GET", `/repos/${REPO}/pulls?head=${REPO.split("/")[0]}:${BRANCH}&state=open`);
  if (!prs.length) { console.log("[security-wait] no open PR"); return; }
  const sha = prs[0].head.sha;
  await api("POST", `/repos/${REPO}/statuses/${sha}`, { state, context: CONTEXT, description: description.slice(0, 140) });
  console.log(`[security-wait] posted ${CONTEXT}=${state} — ${description}`);
}

async function main() {
  const prs = await api("GET", `/repos/${REPO}/pulls?head=${REPO.split("/")[0]}:${BRANCH}&state=open`);
  if (!prs.length) { console.log("[security-wait] no open PR — nothing to wait for"); return; }
  const pr = prs[0].number;
  console.log(`[security-wait] waiting up to ${POLL_TIMEOUT}s for aws-security-agent[bot] on PR #${pr} (block at ${BLOCK_LEVEL})`);
  const deadline = Date.now() + POLL_TIMEOUT * 1000;
  let sawAck = false;
  while (Date.now() < deadline) {
    const reviews = (await api("GET", `/repos/${REPO}/pulls/${pr}/reviews?per_page=100`).catch(() => [])) || [];
    const comments = (await api("GET", `/repos/${REPO}/pulls/${pr}/comments?per_page=100`).catch(() => [])) || [];
    const issueComments = (await api("GET", `/repos/${REPO}/issues/${pr}/comments?per_page=100`).catch(() => [])) || [];
    const botReview = reviews.filter((r) => isSecBot((r.user || {}).login)).slice(-1)[0];
    const inline = comments.filter((c) => isSecBot((c.user || {}).login)).length;
    // "reviewing…" ack lands as an issue comment before the verdict review.
    if (issueComments.some((c) => isSecBot((c.user || {}).login) && /reviewing|will post/i.test(c.body || ""))) sawAck = true;
    // A "No issues identified." can also be posted as an issue comment (not a review).
    const cleanComment = issueComments.some((c) => isSecBot((c.user || {}).login) && /no (issues identified|findings)/i.test(c.body || ""));

    const verdict = botReview ? classify(botReview.body, inline, sawAck)
      : (cleanComment ? { done: true, findings: 0, desc: "no findings" }
      : (inline > 0 ? { done: true, findings: inline, desc: `${inline} finding(s)` } : { done: false }));

    if (verdict.done) {
      const blocked = BLOCK_LEVEL !== "none" && verdict.findings > 0;
      await postStatus(blocked ? "failure" : "success", `security: ${verdict.desc}${verdict.findings > 0 && !blocked ? " (advisory)" : ""}`);
      return;
    }
    await sleep(15);
  }
  // Timed out. Prefer NOT to green a PR the bot never cleared — post pending so the
  // consolidated review shows "in progress" rather than a false pass.
  console.log("[security-wait] timed out waiting for the Security Agent bot verdict");
  await postStatus("pending", "security: AWS Security Agent review still in progress (timed out waiting)");
}

main().catch((e) => { console.error(`[security-wait] error (non-fatal): ${e.message}`); process.exit(0); });
