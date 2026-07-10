// github.js — the ONE sticky PR status comment + PR creation.
//
// Flow B's canonical human surface (§7): the orchestrator maintains a single
// comment edited in place as each stage completes — no comment spam. The
// comment is found by a hidden marker so re-runs update the same comment.
//
// Uses the GitHub REST API directly (no SDK dep) with a short-TTL token the
// GitHub Action mints and hands to the orchestrator per run. The orchestrator
// holds the app credentials; the untrusted sandbox never sees this token.
const https = require("https");

const API = "api.github.com";
const MARKER = "<!-- dark-factory:status -->";

// Ordered pipeline stages shown in the sticky comment. P1 stops before the
// verification stages (holdout/security/devops arrive in P2/P3) — they render
// as pending placeholders so the surface is stable across phases.
const STAGES = [
  { key: "claim", label: "Claimed sandbox (spoke-dev)" },
  { key: "branch", label: "Branch" },
  { key: "implement", label: "Implement" },
  { key: "test", label: "Build + unit tests" },
  { key: "security", label: "Security Agent", phase: "P3" },
  { key: "devops", label: "DevOps Agent", phase: "P3" },
  { key: "holdout", label: "Holdout gate", phase: "P2" },
  { key: "pr", label: "PR ready for review" },
];

function icon(state) {
  return { done: "✅", now: "⏳", wait: "⬜", fail: "❌" }[state] || "⬜";
}

// Render the sticky comment body from a { stageKey: {state, at, note, log} } map.
function renderStatus(issueNumber, states) {
  const lines = [MARKER, `## 🏭 Dark Factory — issue #${issueNumber}`, ""];
  for (const s of STAGES) {
    const st = states[s.key] || { state: "wait" };
    const bits = [icon(st.state), s.label];
    if (st.note) bits.push(`· ${st.note}`);
    if (s.phase && st.state === "wait") bits.push(`_(${s.phase})_`);
    if (st.at) bits.push(`· ${st.at}`);
    if (st.log) bits.push(`· [📄 log](${st.log})`);
    lines.push(bits.join(" "));
  }
  lines.push("", "_Human reviews **results, not diffs**. Approve the PR to merge + teardown._");
  return lines.join("\n");
}

function ghRequest(token, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        host: API,
        method,
        path,
        headers: {
          "User-Agent": "dark-factory-orchestrator",
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(buf ? JSON.parse(buf) : {});
          } else {
            reject(new Error(`GitHub ${method} ${path} → ${res.statusCode}: ${buf}`));
          }
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Find our sticky comment on an issue/PR (they share the comments endpoint).
async function findStickyComment(token, repo, issueNumber) {
  const comments = await ghRequest(
    token,
    "GET",
    `/repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
  );
  return comments.find((c) => (c.body || "").includes(MARKER));
}

// Upsert the sticky comment (create once, then edit in place).
async function upsertStatus(token, repo, issueNumber, states) {
  const body = renderStatus(issueNumber, states);
  const existing = await findStickyComment(token, repo, issueNumber);
  if (existing) {
    return ghRequest(token, "PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
  }
  return ghRequest(token, "POST", `/repos/${repo}/issues/${issueNumber}/comments`, { body });
}

// Open the PR for the coder's branch. Body carries the evidence report.
async function openPullRequest(token, repo, { head, base, title, body }) {
  return ghRequest(token, "POST", `/repos/${repo}/pulls`, {
    title,
    head,
    base: base || "main",
    body,
    maintainer_can_modify: true,
  });
}

module.exports = { STAGES, renderStatus, upsertStatus, openPullRequest, findStickyComment };
