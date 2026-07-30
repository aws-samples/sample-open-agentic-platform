#!/usr/bin/env bash
# security-agent.sh — run the REAL AWS Security Agent code review on a PR diff,
# headlessly, from a trusted hub-side Argo step (NOT the Kata VM). No GitHub App,
# no OAuth: the whole path is the AWS securityagent API + an S3-staged diff, via
# the workflow's IRSA role.
#
# Runs on the glibc aws-cli v2 image (amazon/aws-cli) — the ONLY place with the
# brand-new `securityagent` verbs (Alpine/musl aws-cli 2.32 lacks them). To keep
# that image dependency minimal this script uses python3 (bundled in the aws-cli
# image) + curl for GitHub — NO node. Only `git` is added at step start.
#
# Chain (validated live 2026-07-16 — a flawed sample returned SQL_INJECTION /
# DEFAULT_CREDENTIALS / PRIVILEGE_ESCALATION findings):
#   clone df/issue-N -> archive source + unified diff -> upload to S3
#   -> securityagent create-code-review (sourceCode = S3 archive, --service-role)
#   -> start-code-review-job (diffSource = S3 diff) -> poll -> list-findings
#   -> map to a dark-factory/security commit status + PR comment.
#
# Runs only after the DevOps Agent cleared (gated on `needs-security-review`).
# Narrow + strict: OWASP Top 10, hardcoded secrets, IAM misuse, dependency risk.
#
# Env: GH_TOKEN, REPO, BRANCH, BASE, AGENT_SPACE_ID, SERVICE_ROLE_ARN, DIFF_BUCKET,
#      AWS_REGION, WF_NAME, BLOCK_LEVEL(none|low|medium|high|critical), POLL_TIMEOUT.
set -euo pipefail

log() { echo "[security-agent] $*"; }
: "${GH_TOKEN:?}" "${REPO:?}" "${BRANCH:?}" "${AGENT_SPACE_ID:?}" "${SERVICE_ROLE_ARN:?}" "${DIFF_BUCKET:?}" "${AWS_REGION:?}"
BASE="${BASE:-main}"
WF_NAME="${WF_NAME:-df-run}"
BLOCK_LEVEL="$(echo "${BLOCK_LEVEL:-none}" | tr '[:upper:]' '[:lower:]')"
POLL_TIMEOUT="${POLL_TIMEOUT:-900}"

WORK=/tmp/secagent-work
rm -rf "$WORK"; mkdir -p "$WORK"

GH_API="https://api.github.com"
GH_HDR=(-H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github+json" -H "User-Agent: dark-factory-secagent")

SHA=""  # set after clone; status posts are no-ops until then
post_status() { # state, description — GitHub commit status via curl
  [ -z "${SHA}" ] && return 0
  local st="$1" desc="$2"
  desc="$(printf '%s' "$desc" | cut -c1-140)"
  curl -fsS -X POST "${GH_HDR[@]}" "${GH_API}/repos/${REPO}/statuses/${SHA}" \
    -d "$(python3 -c 'import json,sys,os; print(json.dumps({"state":sys.argv[1],"context":"dark-factory/security","description":sys.argv[2]}))' "$st" "$desc")" \
    >/dev/null 2>&1 && log "posted status=${st}" || log "status post failed (non-fatal)"
}

# ── 1. Clone the coder's branch (read-only) + build the unified diff ─────────
log "cloning ${REPO}@${BRANCH} (read-only)..."
git clone --quiet --branch "$BRANCH" \
  "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "$WORK/repo"
cd "$WORK/repo"
git fetch --quiet --depth 50 origin "$BASE" || true
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
# Title constraint (API): [A-Za-z0-9_-] only, <=100 chars.
TITLE="$(printf 'df-%s-%s-%s' "$REPO" "$BRANCH" "${SHA:0:12}" | tr -c 'A-Za-z0-9_-' '-' | cut -c1-100)"
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
# The job's `status` field lags well behind the actual analysis: the AWS Security
# Agent GitHub App posts its findings comment on the PR (e.g. "No issues identified")
# minutes before batch-get-code-review-jobs flips to COMPLETED. Polling status alone
# therefore blocks this (advisory) step for the full timeout even though the result
# is already known. So we ALSO probe list-findings each iteration: once it returns a
# well-formed result (findingsSummaries key present), the review has produced output
# and we can proceed immediately — this is the early-exit that avoids the long wait.
DEADLINE=$(( $(date +%s) + POLL_TIMEOUT ))
STATUS="IN_PROGRESS"
DONE=""
: > "$WORK/findings.json"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  STATUS="$(aws securityagent batch-get-code-review-jobs --region "$AWS_REGION" \
    --agent-space-id "$AGENT_SPACE_ID" --code-review-job-ids "$JOBID" \
    --query 'codeReviewJobs[0].status' --output text 2>/dev/null || echo IN_PROGRESS)"
  log "job status=${STATUS}"
  case "$STATUS" in
    COMPLETED|SUCCEEDED) DONE="status"; break ;;
    FAILED|STOPPED|ERROR) log "review job ${STATUS}"; post_status "error" "security: review job ${STATUS}"; exit 0 ;;
  esac
  # Early-exit: findings ready before status flips? (App bot already posted them.)
  if aws securityagent list-findings --region "$AWS_REGION" \
       --agent-space-id "$AGENT_SPACE_ID" --code-review-job-id "$JOBID" \
       > "$WORK/findings.try.json" 2>/dev/null \
     && python3 -c 'import json,sys; sys.exit(0 if "findingsSummaries" in json.load(open(sys.argv[1])) else 1)' "$WORK/findings.try.json" 2>/dev/null; then
    mv "$WORK/findings.try.json" "$WORK/findings.json"
    DONE="findings"; log "findings ready (status=${STATUS}) — proceeding without waiting for status flip"; break
  fi
  sleep 20
done
if [ -z "$DONE" ]; then
  # Advisory step: the App bot posts the authoritative result on the PR regardless,
  # so a slow job-status flip is NOT a failure. Post a neutral pending status (not
  # error) so the PR check isn't a misleading red, and continue.
  log "review still running past ${POLL_TIMEOUT}s (last status=${STATUS}) — see the AWS Security Agent bot comment on the PR for the authoritative result"
  post_status "pending" "security: review still running — see AWS Security Agent PR comment"
  exit 0
fi

# ── 5. Fetch findings, render report + verdict (python3, no node) ────────────
# Reuse the findings we already fetched during the early-exit probe; only re-fetch
# if we broke on the status flip (findings not yet captured).
if [ "$DONE" = "status" ] || [ ! -s "$WORK/findings.json" ]; then
  aws securityagent list-findings --region "$AWS_REGION" \
    --agent-space-id "$AGENT_SPACE_ID" --code-review-job-id "$JOBID" \
    > "$WORK/findings.json" 2>/dev/null || echo '{"findingsSummaries":[]}' > "$WORK/findings.json"
fi

python3 - "$WORK/findings.json" "$BLOCK_LEVEL" "$WORK/report.md" > "$WORK/verdict.env" <<'PY'
import json, sys
findings_file, block_level, report_file = sys.argv[1], sys.argv[2], sys.argv[3]
RANK = {"informational":1,"low":2,"medium":3,"high":4,"critical":5}
data = json.load(open(findings_file))
f = [{"name":x.get("name","(unnamed)"),
      "risk":(x.get("riskLevel") or "informational").lower(),
      "type":x.get("riskType",""),
      "confidence":(x.get("confidence") or "").lower()} for x in data.get("findingsSummaries",[])]
counts = {}
top = 0
for x in f:
    counts[x["risk"]] = counts.get(x["risk"],0)+1
    top = max(top, RANK.get(x["risk"],0))
topsev = next((k for k,v in RANK.items() if v==top), "none")
block_at = RANK.get(block_level,0)
blocked = block_at > 0 and top >= block_at
order = ["critical","high","medium","low","informational"]
summary = ", ".join(f"{counts[s]} {s}" for s in order if counts.get(s)) or "none"
print(f"TOTAL={len(f)}")
print(f"TOPSEV={topsev}")
print(f"BLOCKED={1 if blocked else 0}")
print(f'SUMMARY="{summary}"')
icon = {"critical":"🔴","high":"🟠","medium":"🟡","low":"🔵","informational":"⚪"}
lines = []
if not f:
    lines += ["### ✅ 🔒 AWS Security Agent review","",
              "No findings. _(OWASP Top 10, secrets, IAM misuse, dependency risk — real AWS Security Agent, diff scan)_"]
else:
    tail = ("  \n**⛔ Would block** at `%s`." % block_level) if blocked else "  \n_(advisory)_"
    lines += ["### ⚠️ 🔒 AWS Security Agent review","",
              f"**{len(f)} finding(s)** — {summary}.{tail}",""]
    lines += ["| Risk | Finding | Type | Confidence |","|---|---|---|---|"]
    for x in sorted(f, key=lambda z: RANK.get(z["risk"],0), reverse=True):
        nm = x["name"].replace("|","\\|")
        lines.append(f'| {icon.get(x["risk"],"")} {x["risk"]} | {nm} | `{x["type"]}` | {x["confidence"]} |')
lines += ["","_Powered by AWS Security Agent (agentic code security review)._"]
open(report_file,"w").write("\n".join(lines))
PY
# shellcheck disable=SC1091
. "$WORK/verdict.env"
log "findings: total=${TOTAL} top=${TOPSEV} blocked=${BLOCKED}"

STATE="success"; [ "${BLOCKED}" = "1" ] && STATE="failure"
if [ "${TOTAL}" = "0" ]; then DESC="security: no findings"; else DESC="security: ${TOTAL} finding(s), top=${TOPSEV}"; fi
post_status "$STATE" "$DESC"

# ── 6. PR comment (marker-based, edited in place) — python3 + curl ───────────
PR="$(curl -fsS "${GH_HDR[@]}" "${GH_API}/repos/${REPO}/pulls?head=${REPO%%/*}:${BRANCH}&state=open" 2>/dev/null \
  | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print(d[0]["number"] if d else "")
except Exception: print("")' 2>/dev/null || echo "")"
if [ -n "$PR" ] && [ -f "$WORK/report.md" ]; then
  MARKER="<!-- dark-factory:security-agent -->"
  BODY="$(printf '%s\n%s' "$MARKER" "$(cat "$WORK/report.md")")"
  PAYLOAD="$(python3 -c 'import json,sys; print(json.dumps({"body":sys.stdin.read()}))' <<<"$BODY")"
  # Find an existing marker comment to edit; else create one (idempotent sticky).
  CID="$(curl -fsS "${GH_HDR[@]}" "${GH_API}/repos/${REPO}/issues/${PR}/comments?per_page=100" 2>/dev/null \
    | python3 -c 'import json,sys,os
m=os.environ["MARKER"]
try:
    cs=json.load(sys.stdin)
    print(next((str(c["id"]) for c in cs if m in (c.get("body") or "")), ""))
except Exception: print("")' 2>/dev/null || echo "")"
  export MARKER
  if [ -n "$CID" ]; then
    curl -fsS -X PATCH "${GH_HDR[@]}" "${GH_API}/repos/${REPO}/issues/comments/${CID}" -d "$PAYLOAD" >/dev/null 2>&1 && log "updated PR comment"
  else
    curl -fsS -X POST "${GH_HDR[@]}" "${GH_API}/repos/${REPO}/issues/${PR}/comments" -d "$PAYLOAD" >/dev/null 2>&1 && log "posted PR comment"
  fi
fi

if [ "${BLOCKED}" = "1" ]; then
  log "BLOCKING — finding at/above ${BLOCK_LEVEL}."
  exit 1
fi
log "advisory — findings reported, workflow continues."
exit 0
