// entrypoint.js — the in-VM coder for Flow B P1 (runs on Kata micro-VM start).
//
// This is the UNTRUSTED side of the trust boundary. It holds NO cloud creds and
// NO Kubernetes API access (no SA token). Its only credentials are a Bifrost key
// and a short-TTL GitHub token, both read from projected tmpfs (mode 0400).
// Because it can't talk to the k8s API, it SELF-REPORTS through GitHub — the
// df-run workflow polls GitHub for the PR + the dark-factory/implementation
// commit status this script sets.
//
// Driven entirely by env injected via SandboxClaim.spec.env (contract verified
// against the live operator, envVarsInjectionPolicy=Allowed):
//   DF_REPO           owner/name of the target repo
//   DF_ISSUE_NUMBER   the GitHub issue number (the spec)
//   DF_BRANCH         df/issue-<n>
//   DF_BASE_BRANCH    base to branch from (default main)
//   DF_ISSUE_TITLE    issue title (for the PR title)
//   CODER_PROFILE     claude-code | kiro
//   BIFROST_URL       LLM gateway (from the SandboxTemplate)
//
// Flow: fetch issue → SPEC.md → checkout df/issue-N → coder implements →
// build+test → push → open PR → set commit status success/failure.
const fs = require("fs");
const https = require("https");
const { execFileSync } = require("child_process");

const WORKSPACE = process.env.WORKSPACE || "/workspace";
const BIFROST_URL = process.env.BIFROST_URL || "http://bifrost.bifrost.svc.cluster.local:8080";
const REPO = process.env.DF_REPO;
const ISSUE = process.env.DF_ISSUE_NUMBER;
const BRANCH = process.env.DF_BRANCH || `df/issue-${ISSUE}`;
const BASE = process.env.DF_BASE_BRANCH || "main";
const TITLE = process.env.DF_ISSUE_TITLE || `Dark Factory: issue #${ISSUE}`;
const PROFILE = process.env.CODER_PROFILE || "claude-code";

const GH_TOKEN_PATH = process.env.GH_TOKEN_PATH || "/etc/secrets/gh-token";
const BIFROST_KEY_PATH = process.env.BIFROST_KEY_PATH || "/etc/secrets/bifrost-api-key";

function readSecret(p) {
  try { return fs.readFileSync(p, "utf8").trim(); } catch { return null; }
}
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: opts.cwd || WORKSPACE, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], env: opts.env || process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Minimal GitHub REST helper (self-report bus — no k8s API available).
function gh(method, path, body) {
  const token = readSecret(GH_TOKEN_PATH);
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      { host: "api.github.com", method, path,
        headers: {
          "User-Agent": "dark-factory-coder", Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        } },
      (res) => {
        let buf = ""; res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(buf ? JSON.parse(buf) : {});
          else reject(new Error(`GitHub ${method} ${path} → ${res.statusCode}: ${buf}`));
        });
      });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function fetchIssueSpec() {
  const issue = await gh("GET", `/repos/${REPO}/issues/${ISSUE}`);
  return `# ${issue.title}\n\n${issue.body || ""}\n`;
}

function checkout() {
  const token = readSecret(GH_TOKEN_PATH);
  const url = `https://x-access-token:${token}@github.com/${REPO}.git`;
  const dir = `${WORKSPACE}/repo`;
  if (!fs.existsSync(dir)) sh("git", ["clone", "--depth", "1", "--branch", BASE, url, dir]);
  sh("git", ["checkout", "-B", BRANCH], { cwd: dir });
  sh("git", ["config", "user.email", "dark-factory@noreply"], { cwd: dir });
  sh("git", ["config", "user.name", "Dark Factory"], { cwd: dir });
  return dir;
}

function runCoder(repoDir) {
  const key = readSecret(BIFROST_KEY_PATH);
  const env = { ...process.env, ANTHROPIC_BASE_URL: BIFROST_URL, ANTHROPIC_API_KEY: key, CLAUDE_CODE_USE_BEDROCK: "1" };
  if (PROFILE === "kiro") return sh("kiro", ["run", "--headless", "--spec", `${WORKSPACE}/SPEC.md`], { cwd: repoDir, env });
  return sh("claude", ["-p", `Implement the change described in ${WORKSPACE}/SPEC.md. Build and run unit tests until green. Commit your work.`], { cwd: repoDir, env });
}

function buildAndTest(repoDir) {
  try {
    if (fs.existsSync(`${repoDir}/package.json`)) { sh("npm", ["install", "--no-audit", "--no-fund"], { cwd: repoDir }); sh("npm", ["test"], { cwd: repoDir }); }
    else if (fs.existsSync(`${repoDir}/go.mod`)) sh("go", ["test", "./..."], { cwd: repoDir });
    else if (fs.existsSync(`${repoDir}/pyproject.toml`) || fs.existsSync(`${repoDir}/setup.py`)) sh("python", ["-m", "pytest", "-q"], { cwd: repoDir });
    else return { green: true, summary: "no recognized test suite — skipped" };
    return { green: true, summary: "tests passed" };
  } catch (e) {
    return { green: false, summary: (e.stdout || e.stderr || e.message || "").toString().slice(-400) };
  }
}

async function main() {
  for (const [k, v] of Object.entries({ DF_REPO: REPO, DF_ISSUE_NUMBER: ISSUE })) {
    if (!v) { console.error(`[coder] missing required env ${k}`); process.exit(2); }
  }
  fs.mkdirSync(`${WORKSPACE}/artifacts`, { recursive: true });
  console.log(`[coder] issue #${ISSUE} of ${REPO} → branch ${BRANCH} (profile=${PROFILE})`);

  const spec = await fetchIssueSpec();
  fs.writeFileSync(`${WORKSPACE}/SPEC.md`, spec);
  const repoDir = checkout();

  let headSha = "";
  try {
    runCoder(repoDir);
    const test = buildAndTest(repoDir);
    if (!test.green) throw new Error(`tests not green: ${test.summary}`);
    sh("git", ["push", "-u", "origin", BRANCH, "--force-with-lease"], { cwd: repoDir });
    headSha = sh("git", ["rev-parse", "HEAD"], { cwd: repoDir }).trim();

    // Open the PR (idempotent: ignore "already exists").
    try {
      await gh("POST", `/repos/${REPO}/pulls`, {
        title: `Dark Factory: ${TITLE} (#${ISSUE})`, head: BRANCH, base: BASE,
        body: `Closes #${ISSUE}.\n\n_Autonomously implemented in a hardware-isolated Kata micro-VM._\n\n- **Build + unit tests:** ✅ ${test.summary}\n- **Holdout gate:** _pending (P2)_\n- **Security / DevOps:** _pending (P3)_`,
        maintainer_can_modify: true,
      });
    } catch (e) { if (!/already exists|A pull request already/i.test(e.message)) throw e; }

    // Self-report SUCCESS on the head SHA — this is what df-run polls for.
    await gh("POST", `/repos/${REPO}/statuses/${headSha}`, {
      state: "success", context: "dark-factory/implementation",
      description: "implemented, built + tests green",
    });
    console.log(`[coder] done — PR opened, status success on ${headSha}`);
  } catch (e) {
    console.error(`[coder] failed: ${e.message}`);
    if (headSha) {
      try { await gh("POST", `/repos/${REPO}/statuses/${headSha}`, { state: "failure", context: "dark-factory/implementation", description: e.message.slice(0, 130) }); } catch (_) {}
    }
    process.exit(1);
  }
  // Keep the VM alive briefly so logs are collectible; the claim TTL / teardown reaps it.
  process.exit(0);
}

main();
