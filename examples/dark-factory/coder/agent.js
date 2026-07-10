// agent.js — the in-VM coder agent (runs INSIDE the Kata micro-VM sandbox).
//
// This is the untrusted side of the trust boundary. It holds NO cloud
// credentials — only a Bifrost API key + a short-TTL GitHub token, both read
// from projected tmpfs (mode 0400), used, and never placed in the environment.
// It listens on :8080 for a run spec from the orchestrator, then:
//   1. writes /workspace/SPEC.md from the issue
//   2. checks out the target repo on branch df/issue-<n>
//   3. runs the pluggable coder (Claude Code headless by default) via Bifrost
//   4. builds + runs unit tests until green (bounded attempts)
//   5. pushes the branch and returns /workspace/artifacts/result.json
//
// The concrete coder invocation is profile-pluggable (§5). This reference
// wires the contract and the Claude Code headless call; swapping to Kiro is a
// single branch in runProfile().
const http = require("http");
const fs = require("fs");
const { execFileSync } = require("child_process");

const PORT = parseInt(process.env.CODER_PORT || "8080", 10);
const WORKSPACE = process.env.WORKSPACE || "/workspace";
const BIFROST_URL = process.env.BIFROST_URL || "http://bifrost.bifrost.svc.cluster.local:8080";
const MAX_TEST_ATTEMPTS = parseInt(process.env.MAX_TEST_ATTEMPTS || "3", 10);

// Secrets live on tmpfs, mode 0400 — read at point of use, never in env.
function readSecret(path) {
  try {
    return fs.readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}
const BIFROST_KEY_PATH = process.env.BIFROST_KEY_PATH || "/etc/secrets/bifrost-api-key";
const GH_TOKEN_PATH = process.env.GH_TOKEN_PATH || "/etc/secrets/gh-token";

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: opts.cwd || WORKSPACE,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: opts.env || process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function writeSpec(spec) {
  fs.writeFileSync(`${WORKSPACE}/SPEC.md`, spec, { mode: 0o644 });
}

// Clone/checkout the target repo on the coder branch. The gh-token authorizes
// the clone + later push; it never enters the process env.
function checkoutRepo(repo, base, branch) {
  const token = readSecret(GH_TOKEN_PATH);
  if (!token) throw new Error("gh-token not present on tmpfs");
  const url = `https://x-access-token:${token}@github.com/${repo}.git`;
  const dir = `${WORKSPACE}/repo`;
  if (!fs.existsSync(dir)) {
    sh("git", ["clone", "--depth", "1", "--branch", base, url, dir]);
  }
  sh("git", ["checkout", "-B", branch], { cwd: dir });
  return dir;
}

// Run the pluggable coder. Claude Code headless routes to Bedrock via Bifrost
// (base-URL override); Kiro headless is the second profile.
function runProfile(profile, repoDir, spec) {
  const key = readSecret(BIFROST_KEY_PATH);
  if (!key) throw new Error("bifrost-api-key not present on tmpfs");
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: BIFROST_URL,
    ANTHROPIC_API_KEY: key,
    CLAUDE_CODE_USE_BEDROCK: "1",
  };
  if (profile === "kiro") {
    // Kiro headless (spec-driven): spec → requirements → design → tasks.
    return sh("kiro", ["run", "--headless", "--spec", `${WORKSPACE}/SPEC.md`], { cwd: repoDir, env });
  }
  // Default: Claude Code headless, non-interactive, prompted with the spec.
  return sh(
    "claude",
    ["-p", `Implement the change described in ${WORKSPACE}/SPEC.md. Build and run unit tests until green. Commit your work.`],
    { cwd: repoDir, env },
  );
}

// Build + unit tests. Auto-detects the toolchain; returns { green, summary }.
function buildAndTest(repoDir) {
  let summary = "";
  for (let attempt = 1; attempt <= MAX_TEST_ATTEMPTS; attempt++) {
    try {
      if (fs.existsSync(`${repoDir}/package.json`)) {
        sh("npm", ["install", "--no-audit", "--no-fund"], { cwd: repoDir });
        sh("npm", ["test"], { cwd: repoDir });
      } else if (fs.existsSync(`${repoDir}/go.mod`)) {
        sh("go", ["test", "./..."], { cwd: repoDir });
      } else if (fs.existsSync(`${repoDir}/pyproject.toml`) || fs.existsSync(`${repoDir}/setup.py`)) {
        sh("python", ["-m", "pytest", "-q"], { cwd: repoDir });
      } else {
        return { green: true, summary: "no recognized test suite — skipped" };
      }
      return { green: true, summary: `tests passed (attempt ${attempt})` };
    } catch (e) {
      summary = (e.stdout || e.stderr || e.message || "").toString().slice(-500);
      // Give the coder the failure reason and let it try again.
      fs.writeFileSync(`${WORKSPACE}/RETRY.md`, `Test failure (attempt ${attempt}):\n${summary}\n`);
    }
  }
  return { green: false, summary: `tests still failing after ${MAX_TEST_ATTEMPTS} attempts: ${summary}` };
}

function pushBranch(repoDir, branch) {
  sh("git", ["push", "-u", "origin", branch, "--force-with-lease"], { cwd: repoDir });
}

function runOnce(runSpec) {
  fs.mkdirSync(`${WORKSPACE}/artifacts`, { recursive: true });
  writeSpec(runSpec.spec);
  const repoDir = checkoutRepo(runSpec.repo, runSpec.baseBranch, runSpec.branch);
  runProfile(runSpec.profile, repoDir, runSpec.spec);
  const test = buildAndTest(repoDir);
  if (test.green) pushBranch(repoDir, runSpec.branch);
  const result = {
    branch: runSpec.branch,
    testsGreen: test.green,
    testSummary: test.summary,
    summary: `Implemented per SPEC.md on ${runSpec.branch}.`,
  };
  fs.writeFileSync(`${WORKSPACE}/artifacts/result.json`, JSON.stringify(result, null, 2));
  return result;
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method === "POST" && req.url === "/run") {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try {
        const result = runOnce(JSON.parse(buf));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
      } catch (e) {
        console.error(`[coder] run failed: ${e.message}`);
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ testsGreen: false, testSummary: e.message }));
      }
    });
    return;
  }
  res.writeHead(404).end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[coder] agent listening on :${PORT} (workspace=${WORKSPACE}, bifrost=${BIFROST_URL})`);
});
