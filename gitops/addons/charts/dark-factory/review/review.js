// review.js — the Dark Factory P3 review roles (Security + DevOps). Runs in a
// HUB-SIDE Argo step (NOT the untrusted Kata VM), READ-ONLY on the coder's diff.
//
// Design (docs §6.2): each role is a pluggable slot with a swappable backend.
//   backend = "aws-agent" → invoke the managed AWS Security/DevOps Agent (out-of-cluster,
//             hub IAM). Not wired in v1 — the managed API is an acknowledged open item.
//   backend = "llm"       → a different-family LLM reviewer (Nova, not the coder's Claude).
//   backend = "linters"   → deterministic static checks only.
//   backend = "auto" (default) → linters (ground truth) + llm (advisory), merged.
//
// This mirrors the holdout gate's philosophy: deterministic checks are the hard
// signal; the LLM is an advisory reviewer. v1 is report-only — findings are posted
// as a commit status + written to a report file for the sticky PR comment; the
// workflow does not fail on findings unless review.blocking=true and a finding is
// at/above review.blockSeverity.
//
// Env (from the workflow step):
//   ROLE          "security" | "devops"
//   BACKEND       auto | linters | llm | aws-agent   (default auto)
//   REPO_DIR      checkout of the coder's df/issue-N branch
//   DIFF          path to the unified diff vs base
//   BIFROST_URL   LLM gateway base (ClusterIP)
//   REVIEW_MODEL  LLM reviewer model (different family than the coder)
//   BLOCK_SEVERITY  none|low|medium|high|critical — min severity that fails the gate (default none = advisory)
//   OUT           where to write the JSON report (default /tmp/review-<role>.json)
const fs = require("fs");
const http = require("http");
const { execFileSync } = require("child_process");

const ROLE = (process.env.ROLE || "security").toLowerCase();
const BACKEND = (process.env.BACKEND || "auto").toLowerCase();
const REPO_DIR = process.env.REPO_DIR || "/workspace/repo";
const DIFF = (() => { try { return fs.readFileSync(process.env.DIFF || "/tmp/diff.patch", "utf8"); } catch { return ""; } })();
const BIFROST_URL = (process.env.BIFROST_URL || "http://172.20.181.17:8080").replace(/\/+$/, "");
const REVIEW_MODEL = process.env.REVIEW_MODEL || "us.amazon.nova-pro-v1:0";
const BLOCK_SEVERITY = (process.env.BLOCK_SEVERITY || "none").toLowerCase();
const OUT = process.env.OUT || `/tmp/review-${ROLE}.json`;

const SEV = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
const finding = (severity, title, detail, source) => ({ severity, title, detail: String(detail || "").slice(0, 300), source });

// ── Deterministic linters (the hard, un-gameable signal) ─────────────────────

// Files added/modified in the diff (so reviewers focus on the change, not the whole repo).
function changedFiles() {
  const files = new Set();
  for (const line of DIFF.split("\n")) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m && m[1] !== "/dev/null") files.add(m[1]);
  }
  return [...files];
}
const addedLines = () => DIFF.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));

function securityLinters() {
  const out = [];
  // 1. Dependency vulnerabilities (npm audit — present in the coder image).
  if (fs.existsSync(`${REPO_DIR}/package.json`)) {
    try {
      execFileSync("npm", ["install", "--no-audit", "--no-fund", "--package-lock-only"], { cwd: REPO_DIR, stdio: "ignore", timeout: 60000 });
      const raw = execFileSync("npm", ["audit", "--json"], { cwd: REPO_DIR, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"] });
      const a = JSON.parse(raw);
      const v = (a.metadata && a.metadata.vulnerabilities) || {};
      for (const sev of ["critical", "high", "moderate", "low"]) {
        if (v[sev] > 0) out.push(finding(sev === "moderate" ? "medium" : sev, `${v[sev]} ${sev} npm advisory(ies)`, "npm audit reported vulnerable dependencies", "npm-audit"));
      }
    } catch (e) {
      // npm audit exits non-zero when vulns exist; parse stdout if present.
      try { const a = JSON.parse((e.stdout || "").toString()); const v = (a.metadata && a.metadata.vulnerabilities) || {}; for (const sev of ["critical", "high", "moderate", "low"]) if (v[sev] > 0) out.push(finding(sev === "moderate" ? "medium" : sev, `${v[sev]} ${sev} npm advisory(ies)`, "npm audit reported vulnerable dependencies", "npm-audit")); } catch { /* no lockfile / audit unavailable — skip */ }
    }
  }
  // 2. Hard-coded secrets introduced in the diff.
  const secretPats = [
    [/AKIA[0-9A-Z]{16}/, "AWS access key id"],
    [/(?:secret|password|passwd|token|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i, "hard-coded credential"],
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key material"],
    [/ghp_[A-Za-z0-9]{36}/, "GitHub personal access token"],
  ];
  for (const line of addedLines()) for (const [re, what] of secretPats) if (re.test(line)) out.push(finding("critical", `Possible ${what} in the diff`, line.trim(), "secret-scan"));
  // 3. Dangerous sinks introduced in the diff (advisory — context matters).
  const sinkPats = [
    [/\beval\s*\(/, "use of eval()"],
    [/child_process|exec\s*\(|execSync|spawn\s*\(/, "shell/command execution"],
    [/\bnew Function\s*\(/, "dynamic Function() construction"],
  ];
  for (const line of addedLines()) for (const [re, what] of sinkPats) if (re.test(line)) out.push(finding("low", `Review: ${what}`, line.trim(), "sink-scan"));
  return out;
}

function devopsLinters() {
  const out = [];
  const files = changedFiles();
  const added = addedLines();
  // Dockerfile hygiene.
  for (const f of files.filter((f) => /Dockerfile/i.test(f))) {
    const body = (() => { try { return fs.readFileSync(`${REPO_DIR}/${f}`, "utf8"); } catch { return ""; } })();
    if (/:latest\b/.test(body) || /FROM\s+\S+\s*$/im.test(body.split("\n").filter((l) => /^FROM/i.test(l)).join("\n")) && !/@sha256:|:\d/.test(body)) out.push(finding("medium", `Unpinned base image in ${f}`, "FROM uses :latest or no tag/digest — non-reproducible builds", "dockerfile"));
    if (!/^USER\s+/im.test(body)) out.push(finding("medium", `${f} runs as root`, "no USER directive — container runs as root", "dockerfile"));
  }
  // Kubernetes manifest hygiene (missing resources / probes / privileged).
  for (const f of files.filter((f) => /(k8s\/|\/templates\/|deployment\.ya?ml|\.ya?ml$)/i.test(f))) {
    const body = (() => { try { return fs.readFileSync(`${REPO_DIR}/${f}`, "utf8"); } catch { return ""; } })();
    if (!/kind:\s*(Deployment|StatefulSet|DaemonSet|Pod)/i.test(body)) continue;
    if (!/resources:/.test(body)) out.push(finding("medium", `No resource requests/limits in ${f}`, "workload has no resources: block — noisy-neighbour + scheduling risk", "k8s"));
    if (!/(livenessProbe|readinessProbe):/.test(body)) out.push(finding("low", `No health probes in ${f}`, "no liveness/readiness probe — degraded rollouts", "k8s"));
    if (/privileged:\s*true/.test(body)) out.push(finding("high", `Privileged container in ${f}`, "securityContext.privileged: true", "k8s"));
  }
  // Config-in-code smell for deploy artifacts.
  for (const line of added) if (/host\s*[:=]\s*['"]?(?:localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+)/i.test(line)) out.push(finding("low", "Hard-coded host/IP in a changed file", line.trim(), "config"));
  return out;
}

// ── LLM reviewer (advisory — different family than the coder) ─────────────────

function llmReview() {
  const role = ROLE === "devops"
    ? `You are a senior DevOps/SRE reviewer. Review ONLY the diff for operability: reliability, deployability, resource/limits, health probes, observability, rollout safety, IaC/config correctness, cost. Do NOT comment on code style.`
    : `You are a senior application-security reviewer. Review ONLY the diff for exploitable security issues: injection, authz/authn gaps, secrets, unsafe deserialization, SSRF, path traversal, insecure dependencies, dangerous sinks. Do NOT comment on code style.`;
  const prompt =
    `${role}\n\nReport ONLY real, actionable findings you can justify from the diff. If there are none, ` +
    `return an empty list — do not invent issues.\n\nDIFF:\n\`\`\`diff\n${DIFF.slice(0, 14000)}\n\`\`\`\n\n` +
    `Answer with ONLY a JSON object: {"findings":[{"severity":"low|medium|high|critical","title":"<short>","detail":"<why + where>"}]}`;
  const body = JSON.stringify({ model: REVIEW_MODEL, max_tokens: 700, messages: [{ role: "user", content: prompt }] });
  const u = new URL(BIFROST_URL + "/anthropic/v1/messages");
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "x-api-key": process.env.BIFROST_KEY || "bifrost", "anthropic-version": "2023-06-01" } },
      (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => {
        try {
          const j = JSON.parse(b);
          const text = (j.content || []).map((c) => c.text || "").join("");
          const m = text.match(/\{[\s\S]*\}/);
          const parsed = m ? JSON.parse(m[0]) : { findings: [] };
          resolve((parsed.findings || []).filter((f) => f && f.title).map((f) => finding((f.severity || "low").toLowerCase(), f.title, f.detail, "llm")));
        } catch { resolve([]); }
      }); });
    req.on("error", () => resolve([]));
    req.write(body); req.end();
  });
}

async function main() {
  let findings = [];
  const useLinters = BACKEND === "auto" || BACKEND === "linters";
  const useLlm = BACKEND === "auto" || BACKEND === "llm";
  if (BACKEND === "aws-agent") {
    // Placeholder: the managed AWS Security/DevOps Agent API is an open item.
    // When available, invoke it here with the hub orchestrator's IAM and map its
    // findings into the same {severity,title,detail,source:"aws-agent"} shape.
    console.log(`[review:${ROLE}] backend=aws-agent not wired in v1 — falling back to auto`);
  }
  if (useLinters || BACKEND === "aws-agent") findings.push(...(ROLE === "devops" ? devopsLinters() : securityLinters()));
  if (useLlm || BACKEND === "aws-agent") { try { findings.push(...(await llmReview())); } catch { /* advisory — ignore */ } }

  // Rank + summarize.
  findings.sort((a, b) => (SEV[b.severity] || 0) - (SEV[a.severity] || 0));
  const top = findings.reduce((m, f) => Math.max(m, SEV[f.severity] || 0), 0);
  const topSev = Object.keys(SEV).find((k) => SEV[k] === top) || "none";
  const blockAt = SEV[BLOCK_SEVERITY] || 0;
  const blocked = blockAt > 0 && top >= blockAt;
  const counts = findings.reduce((c, f) => ((c[f.severity] = (c[f.severity] || 0) + 1), c), {});
  const summary = { role: ROLE, backend: BACKEND, total: findings.length, topSeverity: topSev, counts, blocked, findings };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));

  for (const f of findings) console.log(`[review:${ROLE}] ${f.severity.toUpperCase()} — ${f.title} (${f.source})`);
  console.log(`[review:${ROLE}] ${findings.length} finding(s), top=${topSev}${blocked ? " — BLOCKS (>= " + BLOCK_SEVERITY + ")" : " — advisory"}`);
  // Exit non-zero only when blocking is configured AND a finding meets the bar.
  process.exit(blocked ? 1 : 0);
}

main();
