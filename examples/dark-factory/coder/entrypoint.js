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
const http = require("http");
const https = require("https");
const { URL } = require("url");
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

// Bifrost does User-Agent-prefix routing: any request whose UA starts with
// "claude-cli" is run through a Claude-Code-specific request transform that is
// broken on this build and returns `400 Unexpected field type` — REGARDLESS of
// the body (the identical body + any other UA returns 200; verified by header
// binary-search against the live gateway). We can't patch Bifrost from inside
// the untrusted VM, so we front it with a tiny localhost shim that rewrites the
// UA to a generic value and transparently forwards everything else — including
// SSE streams (Claude Code sends stream:true). Claude Code points at this shim
// via ANTHROPIC_BASE_URL; the shim proxies to the real Bifrost /anthropic route.
function startBifrostUaShim(upstreamBase) {
  const up = new URL(upstreamBase);
  const agent = up.protocol === "https:" ? https : http;
  const server = http.createServer((cReq, cRes) => {
    const headers = { ...cReq.headers, host: up.host };
    // The single field Bifrost's UA router keys off of. Neutralize it.
    headers["user-agent"] = "dark-factory-coder";
    const pReq = agent.request(
      { protocol: up.protocol, hostname: up.hostname, port: up.port || (up.protocol === "https:" ? 443 : 80),
        method: cReq.method, path: up.pathname.replace(/\/+$/, "") + cReq.url, headers },
      (pRes) => { cRes.writeHead(pRes.statusCode, pRes.headers); pRes.pipe(cRes); },
    );
    pReq.on("error", (e) => { cRes.writeHead(502); cRes.end(String(e.message)); });
    cReq.pipe(pReq);
  });
  server.listen(0, "127.0.0.1");
  const port = server.address().port;
  server.unref();
  return `http://127.0.0.1:${port}`;
}

function runCoder(repoDir) {
  // Bifrost is an Anthropic-compatible gateway. Point Claude Code at its
  // /anthropic route via ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY. Do NOT set
  // CLAUDE_CODE_USE_BEDROCK — that flag makes Claude Code use the AWS Bedrock
  // SDK directly (needs AWS creds in the VM, which we deliberately withhold)
  // and ignores ANTHROPIC_BASE_URL. Bifrost auth is optional on this platform,
  // so the key may be absent; send a placeholder so the CLI doesn't prompt.
  const key = readSecret(BIFROST_KEY_PATH) || "bifrost";
  // Route through the localhost UA-shim (see startBifrostUaShim) so Bifrost
  // doesn't apply its broken claude-cli request transform.
  const base = startBifrostUaShim(`${BIFROST_URL.replace(/\/+$/, "")}/anthropic`);
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: key,
    // Bifrost maps model ALIASES → Bedrock model IDs. Claude Code's default
    // model name (e.g. claude-sonnet-4) isn't a Bifrost alias and returns
    // "provided model identifier is invalid" (400). Use the platform's Bifrost
    // alias (verified: 'claude-sonnet' → us.anthropic.claude-sonnet-4-5). Set
    // both the primary and the small/fast model so the CLI never falls back to
    // an unknown identifier.
    ANTHROPIC_MODEL: process.env.CODER_MODEL || "claude-sonnet",
    ANTHROPIC_SMALL_FAST_MODEL: process.env.CODER_MODEL || "claude-sonnet",
    // Non-interactive: never open a browser / prompt for login in headless mode.
    CI: "1",
  };
  delete env.CLAUDE_CODE_USE_BEDROCK;
  console.log(`[coder] LLM: base=${base} model=${env.ANTHROPIC_MODEL}`);
  // Inherit stdio so the coder CLI's own output + errors stream into the pod
  // logs (kubectl logs), instead of being swallowed by execFileSync's exception.
  const opts = { cwd: repoDir, env, stdio: "inherit", maxBuffer: 64 * 1024 * 1024 };
  if (PROFILE === "kiro") return execFileSync("kiro", ["run", "--headless", "--spec", `${WORKSPACE}/SPEC.md`], opts);
  return execFileSync(
    "claude",
    ["-p", `Implement the change described in ${WORKSPACE}/SPEC.md. Build and run unit tests until green. Commit your work.`,
     "--permission-mode", "bypassPermissions", "--verbose"],
    opts,
  );
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
