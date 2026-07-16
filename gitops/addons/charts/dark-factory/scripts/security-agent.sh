#!/usr/bin/env bash
# security-agent.sh — run the REAL AWS Security Agent code review on a PR diff,
# headlessly, from a trusted hub-side Argo step (NOT the Kata VM). No GitHub App,
# no OAuth: the whole path is the AWS securityagent API + an S3-staged diff, via
# the workflow's IRSA role.
#
# This is the exact chain validated live 2026-07-16 (a flawed sample returned
# SQL_INJECTION/DEFAULT_CREDENTIALS/PRIVILEGE_ESCALATION findings):
#   clone df/issue-N -> archive source + unified diff -> upload to S3
#   -> securityagent create-code-review (sourceCode = S3 archive, --service-role)
#   -> start-code-review-job (diffSource = S3 diff)
#   -> poll batch-get-code-review-jobs until COMPLETED
#   -> list-findings -> map to a dark-factory/security commit status + PR comment.
#
# It runs only after the DevOps Agent has cleared the PR (the workflow gates this
# step on the `needs-security-review` label — see df-run DAG). Narrow + strict:
# OWASP Top 10, hardcoded secrets, IAM misuse, dependency risk.
#
# Env (from the df-run security step):
#   GH_TOKEN          GitHub token (clone + status + comment)
#   REPO BRANCH BASE  repo (owner/name), coder branch df/issue-N, base branch
#   AGENT_SPACE_ID    from the bootstrap Secret
#   SERVICE_ROLE_ARN  from the bootstrap Secret (create-code-review --service-role)
#   DIFF_BUCKET       from the bootstrap Secret (S3 staging)
#   AWS_REGION        agent region
#   WF_NAME           workflow name (unique S3 prefix per run)
#   BLOCK_LEVEL       none|low|medium|high|critical — min riskLevel that fails the gate
#   POLL_TIMEOUT      seconds to wait for the review job (default 900)
set -euo pipefail

log() { echo "[security-agent] $*"; }
: "${GH_TOKEN:?}" "${REPO:?}" "${BRANCH:?}" "${AGENT_SPACE_ID:?}" "${SERVICE_ROLE_ARN:?}" "${DIFF_BUCKET:?}" "${AWS_REGION:?}"
BASE="${BASE:-main}"
WF_NAME="${WF_NAME:-df-run}"
BLOCK_LEVEL="$(echo "${BLOCK_LEVEL:-none}" | tr '[:upper:]' '[:lower:]')"
POLL_TIMEOUT="${POLL_TIMEOUT:-900}"

WORK=/tmp/secagent-work
rm -rf "$WORK"; mkdir -p "$WORK"

# ── helper: post the dark-factory/security commit status (defined early so the
# empty-diff / job-failure branches below can call it). node https — no curl. ─
SHA=""  # set after clone; status posts are no-ops until then
post_status() { # state, description
  [ -z "${SHA}" ] && return 0
  GH_TOKEN="$GH_TOKEN" REPO="$REPO" SHA="$SHA" ST="$1" DESC="$2" node -e '
    const https=require("https");
    const body=JSON.stringify({state:process.env.ST,context:"dark-factory/security",description:(process.env.DESC||"").slice(0,140)});
    let n=0;(function p(){const r=https.request({host:"api.github.com",method:"POST",path:"/repos/"+process.env.REPO+"/statuses/"+process.env.SHA,
      headers:{"User-Agent":"dark-factory-secagent","Authorization":"Bearer "+process.env.GH_TOKEN,"Accept":"application/vnd.github+json","Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},
      res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>{if(res.statusCode>=500&&++n<4){setTimeout(p,500*n);return}console.log("[security-agent] status="+process.env.ST+" ("+res.statusCode+")")});});
      r.on("error",e=>{if(++n<4)setTimeout(p,500*n)});r.write(body);r.end();})();' || true
}

# ── 1. Clone the coder's branch (read-only) + build the unified diff ─────────
log "cloning ${REPO}@${BRANCH} (read-only)..."
git clone --quiet --branch "$BRANCH" \
  "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "$WORK/repo"
cd "$WORK/repo"
git fetch --quiet --depth 50 origin "$BASE" || true
# Diff vs base (fall back to last commit if shallow clone lacks the merge-base).
git diff "origin/${BASE}...HEAD" > "$WORK/diff.patch" 2>/dev/null \
  || git diff HEAD~1 > "$WORK/diff.patch" 2>/dev/null \
  || echo "" > "$WORK/diff.patch"
SHA="$(git rev-parse HEAD)"

if [ ! -s "$WORK/diff.patch" ]; then
  log "empty diff — nothing to review; posting success (advisory)."
  post_status "success" "security: no changes to review"
  exit 0
fi

# ── 2. Package source archive + upload both to S3 ────────────────────────────
log "packaging source + diff -> S3..."
( cd "$WORK" && zip -qr src.zip repo -x 'repo/.git/*' )
PREFIX="runs/${WF_NAME}/${SHA}"
SRC_S3="s3://${DIFF_BUCKET}/${PREFIX}/src.zip"
DIFF_S3="s3://${DIFF_BUCKET}/${PREFIX}/diff.patch"
aws s3 cp "$WORK/src.zip"   "$SRC_S3"  --region "$AWS_REGION" >/dev/null
aws s3 cp "$WORK/diff.patch" "$DIFF_S3" --region "$AWS_REGION" >/dev/null
log "uploaded ${SRC_S3} + ${DIFF_S3}"

# ── 3. create-code-review + start-code-review-job (diff scan) ────────────────
# Title constraint (API): letters, numbers, hyphens, underscores only, <=100 chars.
# Sanitize repo/branch/sha into a safe slug.
TITLE_RAW="df-${REPO}-${BRANCH}-${SHA:0:12}"
TITLE="$(printf '%s' "$TITLE_RAW" | tr -c 'A-Za-z0-9_-' '-' | cut -c1-100)"
log "creating code review (title=${TITLE})..."
CRID="$(aws securityagent create-code-review --region "$AWS_REGION" \
  --title "$TITLE" \
  --agent-space-id "$AGENT_SPACE_ID" \
  --assets "{\"sourceCode\":[{\"s3Location\":\"${SRC_S3}\"}]}" \
  --service-role "$SERVICE_ROLE_ARN" \
  --code-remediation-strategy DISABLED \
  --validation-mode DISABLED \
  --query 'codeReviewId' --output text)"
log "codeReviewId=${CRID}"

JOBID="$(aws securityagent start-code-review-job --region "$AWS_REGION" \
  --agent-space-id "$AGENT_SPACE_ID" \
  --code-review-id "$CRID" \
  --diff-source "{\"s3Uri\":\"${DIFF_S3}\"}" \
  --query 'codeReviewJobId' --output text)"
log "codeReviewJobId=${JOBID} — polling (timeout ${POLL_TIMEOUT}s)..."

# ── 4. Poll to completion ────────────────────────────────────────────────────
DEADLINE=$(( $(date +%s) + POLL_TIMEOUT ))
STATUS="IN_PROGRESS"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  STATUS="$(aws securityagent batch-get-code-review-jobs --region "$AWS_REGION" \
    --agent-space-id "$AGENT_SPACE_ID" --code-review-job-ids "$JOBID" \
    --query 'codeReviewJobs[0].status' --output text 2>/dev/null || echo IN_PROGRESS)"
  log "job status=${STATUS}"
  case "$STATUS" in
    COMPLETED|SUCCEEDED) break ;;
    FAILED|STOPPED|ERROR) log "review job ${STATUS}"; post_status "error" "security: review job ${STATUS}"; exit 0 ;;
  esac
  sleep 20
done
if [ "$STATUS" != "COMPLETED" ] && [ "$STATUS" != "SUCCEEDED" ]; then
  log "timed out waiting for review (last=${STATUS})"; post_status "error" "security: review timed out"; exit 0
fi

# ── 5. Fetch findings, render report, decide the gate ────────────────────────
aws securityagent list-findings --region "$AWS_REGION" \
  --agent-space-id "$AGENT_SPACE_ID" --code-review-job-id "$JOBID" \
  > "$WORK/findings.json" 2>/dev/null || echo '{"findingsSummaries":[]}' > "$WORK/findings.json"

# Rank order for riskLevel; determine top severity + counts + block decision.
node - "$WORK/findings.json" "$BLOCK_LEVEL" <<'NODE' > "$WORK/verdict.env"
const fs = require("fs");
const [file, blockLevel] = process.argv.slice(2);
const RANK = { informational:1, low:2, medium:3, high:4, critical:5 };
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const f = (data.findingsSummaries || []).map(x => ({
  name: x.name || "(unnamed)",
  risk: (x.riskLevel || "informational").toLowerCase(),
  type: x.riskType || "",
  confidence: (x.confidence || "").toLowerCase(),
}));
const counts = {};
let top = 0;
for (const x of f) { counts[x.risk] = (counts[x.risk]||0)+1; top = Math.max(top, RANK[x.risk]||0); }
const topSev = Object.keys(RANK).find(k => RANK[k] === top) || "none";
const blockAt = RANK[blockLevel] || 0;
const blocked = blockAt > 0 && top >= blockAt;
// verdict.env (sourced by bash)
const order = ["critical","high","medium","low","informational"];
const summary = order.filter(s=>counts[s]).map(s=>`${counts[s]} ${s}`).join(", ") || "none";
console.log(`TOTAL=${f.length}`);
console.log(`TOPSEV=${topSev}`);
console.log(`BLOCKED=${blocked ? 1 : 0}`);
console.log(`SUMMARY="${summary}"`);
// Markdown report for the PR comment.
const icon = { critical:"🔴", high:"🟠", medium:"🟡", low:"🔵", informational:"⚪" };
const lines = [];
if (!f.length) {
  lines.push("### ✅ 🔒 AWS Security Agent review", "", "No findings. _(OWASP Top 10, secrets, IAM misuse, dependency risk — real AWS Security Agent, diff scan)_");
} else {
  lines.push(`### ⚠️ 🔒 AWS Security Agent review`, "", `**${f.length} finding(s)** — ${summary}.${blocked ? "  \n**⛔ Would block** at `"+blockLevel+"`." : "  \n_(advisory)_"}`, "");
  lines.push("| Risk | Finding | Type | Confidence |", "|---|---|---|---|");
  for (const x of f.sort((a,b)=>(RANK[b.risk]||0)-(RANK[a.risk]||0)))
    lines.push(`| ${icon[x.risk]||""} ${x.risk} | ${x.name.replace(/\|/g,"\\|")} | \`${x.type}\` | ${x.confidence} |`);
}
lines.push("", "_Powered by AWS Security Agent (agentic code security review)._");
fs.writeFileSync("/tmp/secagent-work/report.md", lines.join("\n"));
NODE
# shellcheck disable=SC1091
. "$WORK/verdict.env"
log "findings: total=${TOTAL} top=${TOPSEV} blocked=${BLOCKED}"

STATE="success"; [ "${BLOCKED}" = "1" ] && STATE="failure"
[ "${TOTAL}" = "0" ] && DESC="security: no findings" || DESC="security: ${TOTAL} finding(s), top=${TOPSEV}"
post_status "$STATE" "$DESC"

# PR comment (marker-based, edited in place) — reuse the shared comment.js.
PR="$(GH_TOKEN="$GH_TOKEN" REPO="$REPO" BRANCH="$BRANCH" node -e 'const https=require("https");https.get({host:"api.github.com",path:"/repos/"+process.env.REPO+"/pulls?head="+process.env.REPO.split("/")[0]+":"+process.env.BRANCH+"&state=open",headers:{"User-Agent":"df","Authorization":"Bearer "+process.env.GH_TOKEN,"Accept":"application/vnd.github+json"}},r=>{let b="";r.on("data",c=>b+=c);r.on("end",()=>{try{console.log(JSON.parse(b)[0].number||"")}catch(e){}})}).on("error",()=>{})' 2>/dev/null || echo "")"
if [ -n "$PR" ] && [ -f "$WORK/report.md" ]; then
  GH_TOKEN="$GH_TOKEN" REPO="$REPO" PR="$PR" node /scripts/comment.js "dark-factory:security-agent" < "$WORK/report.md" || true
fi

# Advisory unless BLOCK_LEVEL was raised and met.
if [ "${BLOCKED}" = "1" ]; then
  log "BLOCKING — finding at/above ${BLOCK_LEVEL}."
  exit 1
fi
log "advisory — findings reported, workflow continues."
exit 0
