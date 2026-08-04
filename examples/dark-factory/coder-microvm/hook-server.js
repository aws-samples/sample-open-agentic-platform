// Flow D — Lambda MicroVM hook server (the lambda-coder wrapper).
//
// Lambda MicroVM is a snapshot/hook runtime: the platform builds an image by
// starting THIS process and snapshotting it once the `ready` hook says "go", then
// resumes that snapshot per session and calls the `run` hook with the session's
// runHookPayload as the request body. Hooks are HTTP endpoints we serve on :8080.
//
// The dark-factory coder (entrypoint.js) is a ONE-SHOT batch job (clone → agent →
// push → PR, 5-15 min). It cannot run inside the 30s run hook, so /run just
// materializes the payload into the coder's file/env contract and BACKGROUND-SPAWNS
// entrypoint.js, then returns 200 immediately. The coder runs async; df-run's
// await-coder step polls GitHub for the PR (same as Kata). The VM stays alive because
// idlePolicy.maxIdleDurationSeconds > a coder run (idle = no inbound traffic).
//
// LLM: USE_BEDROCK=1 → entrypoint.js calls Bedrock DIRECTLY via the MicroVM execution
// role (no Bifrost / EKS-network dependency). See docs/dark-factory/flow-d-coder-in-microvm-design.md.
//
// KEPT MINIMAL: this is the exact shape that built cleanly (v2.0). The /run handler
// stays trivial and synchronous so the build's ready-hook completes fast. Observability
// is via direct endpoint probes, not a /status route (adding one correlated with a
// hung ready-hook build on the pre-GA controller).

const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");

const PORT = parseInt(process.env.HOOKS_PORT || "8080", 10);
const SECRETS_DIR = "/tmp/secrets";
let coderStarted = false;

function startCoder(payload) {
  if (coderStarted) { console.log("[hook-server] /run again — already started, ignoring"); return; }
  coderStarted = true;
  let d = {};
  try { d = JSON.parse(payload || "{}"); } catch (e) { console.log("[hook-server] payload not JSON:", e.message); }
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  if (d.ghToken) fs.writeFileSync(`${SECRETS_DIR}/gh-token`, d.ghToken, { mode: 0o400 });
  const env = {
    ...process.env,
    USE_BEDROCK: "1",
    GH_TOKEN_PATH: `${SECRETS_DIR}/gh-token`,
    AWS_REGION: d.region || process.env.AWS_REGION || "us-west-2",
    DF_ISSUE_NUMBER: d.issueNumber ? String(d.issueNumber) : "",
    DF_REPO: d.repo || "",
    DF_BRANCH: d.branch || (d.issueNumber ? `df/issue-${d.issueNumber}` : ""),
    DF_BASE_BRANCH: d.baseBranch || "main",
    DF_ISSUE_TITLE: d.issueTitle || "",
  };
  if (d.model) env.CODER_MODEL = d.model;
  console.log(`[hook-server] /run → spawning coder for issue #${env.DF_ISSUE_NUMBER} repo=${env.DF_REPO}`);
  // Capture coder output to a file the coder writes; inherit stdio so it also streams
  // to the VM console. detached so it outlives the request handler.
  const child = spawn("node", ["/app/entrypoint.js"], { env, stdio: "inherit", detached: true });
  child.unref();
  child.on("error", (e) => console.log(`[hook-server] coder spawn error: ${e.message}`));
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const ok = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o || { status: "ok" })); };
    switch (req.url) {
      case "/ready":     return ok({ status: "ready" });
      case "/validate":  return ok({ status: "valid" });
      case "/run":       startCoder(body); return ok({ status: "started" });
      case "/suspend":   return ok({ status: "suspended" });
      case "/resume":    return ok({ status: "resumed" });
      case "/terminate": return ok({ status: "terminated" });
      default:           return ok({ status: "ok", path: req.url });
    }
  });
});
server.listen(PORT, () => console.log(`[hook-server] listening on :${PORT} (lambda-coder, Bedrock-direct)`));
