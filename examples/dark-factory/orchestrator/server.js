// server.js — Dark Factory orchestrator (Flow B, phase P1).
//
// Trigger → claim warm sandbox → drive the coder → open PR with a live sticky
// status comment → manual teardown. Runs on spoke-dev only, OUTSIDE the Kata
// sandbox, and is the trusted component: it holds the GitHub token (passed
// per-run by the Action) and — in later phases — AWS IAM. The untrusted coder
// sandbox never receives cloud credentials.
//
// Endpoints:
//   POST /run       { issue, repo, title, body, base, ghToken }  → start a run
//   POST /teardown  { issue, repo, ghToken }                     → release sandbox
//   GET  /healthz
//
// This is the Flow B adaptation of the openclaw session-router: keyed on the
// GitHub issue id instead of a Cognito sub, and it binds a warm sandbox from
// the Flow A SandboxWarmPool via a SandboxClaim rather than creating per-user
// resources.
const http = require("http");
const k8s = require("./lib/k8s");
const gh = require("./lib/github");
const coder = require("./lib/coder");

const PORT = parseInt(process.env.PORT || "8080", 10);
const BIFROST_URL =
  process.env.BIFROST_URL || "http://bifrost.bifrost.svc.cluster.local:8080";

function now() {
  // Wall-clock HH:MM stamp for the sticky comment. Uses the process TZ.
  return new Date().toISOString().slice(11, 16);
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Run the P1 pipeline for one issue. Updates the sticky comment at each stage
// so the human watches the factory work in real time.
async function runPipeline({ issue, repo, title, body, base, ghToken }) {
  const states = {};
  const push = async (key, patch) => {
    states[key] = { ...(states[key] || {}), ...patch };
    try {
      await gh.upsertStatus(ghToken, repo, issue, states);
    } catch (e) {
      console.error(`[orch] status update failed: ${e.message}`);
    }
  };

  // Seed the comment with all stages pending, first one in progress.
  await push("claim", { state: "now" });

  // 1) Claim a warm sandbox (instant if the pool has buffer).
  await k8s.claimSandbox(issue, [
    { name: "BIFROST_URL", value: BIFROST_URL },
    { name: "CODER_PROFILE", value: process.env.CODER_PROFILE || "claude-code" },
  ]);
  const bound = await k8s.waitForClaimBound(issue);
  await push("claim", { state: "done", at: now(), note: bound.name });

  if (!bound.podIPs.length) {
    throw new Error(`bound sandbox ${bound.name} reported no pod IPs`);
  }
  const host = bound.podIPs[0];

  // 2) Drive the coder: SPEC.md + branch + implement/build/test until green.
  await push("branch", { state: "done", at: now(), note: coder.branchName(issue) });
  await push("implement", { state: "now" });

  const runSpec = coder.buildRunSpec({
    issueId: issue,
    repo,
    issueTitle: title,
    issueBody: body,
    base,
  });
  const result = await coder.runCoder(host, runSpec);

  await push("implement", { state: "done", at: now() });
  const testState = result.testsGreen ? "done" : "fail";
  await push("test", {
    state: testState,
    at: now(),
    log: result.logUrl,
    note: result.testSummary,
  });
  if (!result.testsGreen) {
    throw new Error(`coder could not get tests green: ${result.testSummary || "unknown"}`);
  }

  // 3) Verification stages are P2/P3 — leave them pending in the surface.

  // 4) Open the PR with the evidence report. P1 = no auto-merge; the human
  //    approves. Branch protections + CI still apply.
  await push("pr", { state: "now" });
  const pr = await gh.openPullRequest(ghToken, repo, {
    head: coder.branchName(issue),
    base: base || "main",
    title: `Dark Factory: ${title} (#${issue})`,
    body: prBody(issue, result),
  });
  await push("pr", { state: "done", at: now(), note: `#${pr.number}` });

  console.log(`[orch] issue #${issue} → PR #${pr.number} (${pr.html_url})`);
  return { pr: pr.number, url: pr.html_url, sandbox: bound.name };
}

function prBody(issue, result) {
  return [
    `Closes #${issue}.`,
    "",
    "## 🏭 Dark Factory report",
    "",
    "_Autonomously implemented in a hardware-isolated Kata micro-VM (spoke-dev)._",
    "_Review the **evidence** below, not the diff line-by-line._",
    "",
    `- **Build + unit tests:** ${result.testsGreen ? "✅ green" : "❌ failing"}` +
      (result.testSummary ? ` — ${result.testSummary}` : ""),
    result.logUrl ? `- **Logs:** ${result.logUrl}` : "",
    "- **Holdout gate:** _pending (P2)_",
    "- **Security / DevOps agents:** _pending (P3)_",
    "",
    result.summary ? `### What changed\n\n${result.summary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }

    if (req.method === "POST" && req.url === "/run") {
      const b = await readJson(req);
      for (const f of ["issue", "repo", "ghToken"]) {
        if (!b[f]) {
          res.writeHead(400).end(`missing field: ${f}`);
          return;
        }
      }
      // Acknowledge immediately; run the pipeline in the background so the
      // Action's HTTP call doesn't hold open for the whole build.
      res.writeHead(202).end(JSON.stringify({ accepted: true, issue: b.issue }));
      runPipeline(b).catch(async (e) => {
        console.error(`[orch] pipeline failed for #${b.issue}: ${e.message}`);
        try {
          const states = { test: { state: "fail", note: e.message.slice(0, 120) } };
          await gh.upsertStatus(b.ghToken, b.repo, b.issue, states);
        } catch (_) {
          /* best-effort */
        }
      });
      return;
    }

    if (req.method === "POST" && req.url === "/teardown") {
      const b = await readJson(req);
      if (!b.issue) {
        res.writeHead(400).end("missing field: issue");
        return;
      }
      await k8s.releaseSandbox(b.issue);
      res.writeHead(200).end(JSON.stringify({ released: true, issue: b.issue }));
      return;
    }

    res.writeHead(404).end("not found");
  } catch (e) {
    console.error(`[orch] request error: ${e.message}`);
    res.writeHead(500).end(e.message);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[orch] Dark Factory orchestrator listening on :${PORT} ` +
      `(ns=${k8s.NAMESPACE}, warmPool=${k8s.WARM_POOL})`,
  );
});
