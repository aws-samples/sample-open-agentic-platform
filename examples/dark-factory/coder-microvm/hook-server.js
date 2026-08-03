// Flow D — Lambda MicroVM hook server (the lambda-coder wrapper).
//
// Lambda MicroVM is a snapshot/hook runtime: the platform builds an image by
// starting THIS process and snapshotting it once the `ready` hook says "go", then
// resumes that snapshot per session and calls the `run` hook with the session's
// runHookPayload as the request body. Hooks are HTTP endpoints we serve on :8080
// (hooks.port on the MicrovmImage); each must answer within its timeout (run = 30s).
//
// The dark-factory coder (entrypoint.js) is a ONE-SHOT batch job (clone → agent →
// push → PR, 5-15 min). It cannot run *inside* the 30s run hook. So the run hook is
// just the handshake: it materializes the payload into the coder's file/env contract
// and BACKGROUND-SPAWNS entrypoint.js, then returns 200 immediately. The coder then
// runs to completion asynchronously; df-run's await-coder step polls GitHub for the
// PR exactly as it does for Kata. The VM stays alive because idlePolicy.
// maxIdleDurationSeconds on the Microvm is set longer than a coder run (idle = no
// inbound traffic; a background job would otherwise auto-suspend).
//
// LLM: USE_BEDROCK=1 is exported so entrypoint.js calls Bedrock DIRECTLY via the
// MicroVM execution role — no Bifrost / EKS-network dependency (a MicroVM can't reach
// Bifrost's ClusterIP). See docs/dark-factory/flow-d-coder-in-microvm-design.md.

const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");

const PORT = parseInt(process.env.HOOKS_PORT || "8080", 10);
const SECRETS_DIR = "/tmp/secrets";

let coderStarted = false;

// Materialize the runHookPayload (JSON) into the coder's existing contract:
//   files: /tmp/secrets/{gh-token} ; env: DF_*, AWS_REGION, USE_BEDROCK=1
// then background-spawn entrypoint.js. Idempotent: only the first /run starts it.
function startCoder(payload) {
  if (coderStarted) {
    console.log("[hook-server] /run received again — coder already started, ignoring");
    return;
  }
  coderStarted = true;

  let d = {};
  try { d = JSON.parse(payload || "{}"); } catch (e) { console.log("[hook-server] payload not JSON:", e.message); }

  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  if (d.ghToken) fs.writeFileSync(`${SECRETS_DIR}/gh-token`, d.ghToken, { mode: 0o400 });

  const env = {
    ...process.env,
    USE_BEDROCK: "1",                                   // Bedrock-direct (exec-role creds)
    GH_TOKEN_PATH: `${SECRETS_DIR}/gh-token`,
    AWS_REGION: d.region || process.env.AWS_REGION || "us-west-2",
    DF_ISSUE_NUMBER: d.issueNumber ? String(d.issueNumber) : "",
    DF_REPO: d.repo || "",
    DF_BRANCH: d.branch || (d.issueNumber ? `df/issue-${d.issueNumber}` : ""),
    DF_BASE_BRANCH: d.baseBranch || "main",
    DF_ISSUE_TITLE: d.issueTitle || "",
  };
  if (d.model) env.CODER_MODEL = d.model;

  console.log(`[hook-server] /run → background-spawning coder for issue #${env.DF_ISSUE_NUMBER} repo=${env.DF_REPO}`);
  const child = spawn("node", ["/app/entrypoint.js"], { env, stdio: "inherit", detached: false });
  child.on("exit", (code) => console.log(`[hook-server] coder exited code=${code}`));
  child.on("error", (e) => console.log(`[hook-server] coder spawn error: ${e.message}`));
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const ok = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj || { status: "ok" })); };
    switch (req.url) {
      // Build-time: signal the process is initialized so the builder snapshots a
      // clean, waiting coder (no session work baked into the snapshot).
      case "/ready":    return ok({ status: "ready" });
      case "/validate": return ok({ status: "valid" });
      // Per-session start: body IS runHookPayload. Kick off the coder, return fast.
      case "/run":      startCoder(body); return ok({ status: "started" });
      // Lifecycle: coder holds no external state to flush; ack so the service proceeds.
      case "/suspend":  return ok({ status: "suspended" });
      case "/resume":   return ok({ status: "resumed" });
      case "/terminate":return ok({ status: "terminated" });
      default:          return ok({ status: "ok", path: req.url });
    }
  });
});

server.listen(PORT, () => console.log(`[hook-server] listening on :${PORT} (lambda-coder, Bedrock-direct)`));
