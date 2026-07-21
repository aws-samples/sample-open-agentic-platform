# Dark Factory — restore checkpoint (2026-07-20)

## Resume the Claude Code session
    claude --resume ade840e8-b310-4ac7-a173-98e4fbbc5098
(or `claude --resume` and pick it from the list)

## Git state (all pushed — nothing to recover)
- platform repo: sample-open-agentic-platform @ branch dark-factory-autonomous-agent-coding-pattern, HEAD f512706
- sandbox repo:  elamaran11/dark-factory-sandbox @ main (IAM policy from PR #50 merged in)

## STATUS: fully working end-to-end with BOTH real AWS agents
- AWS DevOps Agent (GitHub App) — reviews every PR, posts aws-devops-agent/release-readiness-review
  check; df-run `devops-gate` waits on it, applies needs-security-review label.
- AWS Security Agent — TWO paths, both run: (a) GitHub App → inline aws-security-agent[bot] findings;
  (b) headless code-review API (create-code-review→start-job→list-findings via IRSA).
- Full lifecycle PROVEN: issue #49 → PR #50 → coder wrote least-privilege IAM (infra/iam.tf) →
  terraform validate passed → DevOps approved → Security "no issues" → human (shapirov103) approved →
  df-merge-teardown workflow squash-merged + deleted branch + reaped sandbox → IAM landed in main.

## How merge works (answered): a SEPARATE Argo workflow
- Approval (by a NON-author identity) → GitHub webhook → Argo Sensor `pr-approved` trigger →
  submits `df-merge-teardown` workflow → merge.js re-checks green + squash-merges via GitHub API
  (as the bot PAT elamaran11) → teardown-claim reaps the sandbox.
- Author cannot self-approve (GitHub rule); the coder opens PRs as elamaran11, so approver must differ.

## Recent fixes this session (all committed + deployed hub-side, no image rebuild)
- Security Agent GitHub App connected (App install + connect to dark-factory Agent Space — BOTH steps).
- App posts inline COMMENTS only (no check/status) → securityAgent.app.checkContext/checkRunName EMPTY;
  merge gate uses headless dark-factory/security signal.
- status.js: multi-SHA aggregation (reads statuses/check-runs across ALL PR commits, not just head) —
  fixes "Security review: not run" from SHA drift.
- status.js: holdout row OMITTED entirely when absent or not-applicable (Terraform PRs) — no clutter.
- docs/dark-factory/AGENT-INSTALL.md rewritten GA/public-followable (no allow-list/SIM/preview).
- values.yaml P3 comment corrected to GA reality.

## OPEN (optional, not blocking) — one real robustness gap
- merge.js still reads only pr.head.sha (same head-only bug I fixed in status.js). It merged PR #50
  correctly, but if Security posts a BLOCK on an earlier commit and head moves, the gate could miss it.
  FIX: apply the same multi-SHA aggregation (read statuses+check-runs across all PR commits) to merge.js.

## Config quick-ref (values.yaml)
- coder.engine: claude | kiro ; coder image dark-factory-coder:v0.2.3 (aws-cli/git/zip, subdir discovery)
- devopsAgent: gate=check, checkRunName=aws-devops-agent/release-readiness-review
- securityAgent: headless (enabled) + app.enabled (GitHub App inline bot)
- ArgoCD app dark-factory-hub tracks this branch; control plane on the OPENCLAW cluster
  (kubectl --context openclaw -n argocd port-forward svc/argo-cd-argocd-server 8080:443).
- account 940019131157, us-west-2. Security Agent space as-0fa95663..., DevOps space 65fe3629...
