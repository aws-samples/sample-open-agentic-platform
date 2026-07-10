// coder.js — drive the pluggable coder inside the bound Kata sandbox.
//
// The coder contract crosses the trust boundary as files + env only (§5):
//   INPUTS   /workspace/SPEC.md, /workspace/repo/ (branch df/issue-<n>),
//            tmpfs bifrost-api-key + gh-token (mode 0400)
//   ENV      CODER_PROFILE, BIFROST_URL
//   OUTPUTS  git branch df/issue-<n> + /workspace/artifacts/result.json
//
// P1 talks to the coder over the sandbox's in-VM control endpoint (the coder
// image runs a tiny agent listening on :8080 that accepts a run spec and
// streams stage events). The orchestrator NEVER hands cloud credentials in —
// it only writes the spec and reads back result.json. Secrets reach the
// sandbox via projected tmpfs wired on the SandboxTemplate, out of band.
const http = require("http");

const CODER_PORT = parseInt(process.env.CODER_PORT || "8080", 10);
const CODER_RUN_TIMEOUT_MS = parseInt(
  process.env.CODER_RUN_TIMEOUT_MS || "1800000", // 30 min
  10,
);

function branchName(issueId) {
  return `df/issue-${issueId}`;
}

// POST the run spec to the coder agent inside the sandbox and await result.json.
// `host` is the bound sandbox pod IP (from SandboxClaim.status.sandbox.podIPs).
function runCoder(host, spec) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(spec);
    const req = http.request(
      {
        host,
        port: CODER_PORT,
        path: "/run",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: CODER_RUN_TIMEOUT_MS,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`coder /run → ${res.statusCode}: ${buf}`));
          }
          try {
            resolve(JSON.parse(buf)); // result.json
          } catch (e) {
            reject(new Error(`coder returned non-JSON result: ${buf.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("coder run timed out")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// Build the run spec the coder consumes. The issue body becomes SPEC.md; the
// target repo + branch tell the coder where to work. No secrets in here.
function buildRunSpec({ issueId, repo, issueTitle, issueBody, base }) {
  return {
    spec: `# ${issueTitle}\n\n${issueBody || ""}\n`,
    repo, // e.g. "aws-samples/sample-open-agentic-platform"
    baseBranch: base || "main",
    branch: branchName(issueId),
    profile: process.env.CODER_PROFILE || "claude-code",
    // P1: implement → build → unit tests until green, then open nothing —
    // the orchestrator opens the PR after verification stages.
    tasks: ["implement", "build", "test"],
  };
}

module.exports = { branchName, runCoder, buildRunSpec, CODER_PORT };
