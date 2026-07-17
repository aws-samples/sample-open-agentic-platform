# Dark Factory — restore checkpoint (2026-07-17)

## Resume the Claude Code session
    claude --resume ade840e8-b310-4ac7-a173-98e4fbbc5098
(run from any dir; or `claude --resume` and pick the session from the list)

## Git state (all pushed — nothing to recover)
- platform repo: sample-open-agentic-platform @ branch dark-factory-autonomous-agent-coding-pattern, HEAD d4bac27
- sandbox repo:  elamaran11/dark-factory-sandbox @ main 8a5a888 (infra/ + app/ layout)

## WAITING ON: DevOps Agent 3P access
- Ticket V2290161680 (https://t.corp.amazon.com/53cb3aaf-5fba-4608-82ed-d2908f729c63)
  status=Assigned to cloudsmith-admin-control-plane; accounts 940019131157 + 668668360059
- PREREQ to double-check: internal self-onboarding at
  https://devops-agent-onboarding-self-service.harmony.a2z.com/ (must precede the 3P ticket)

## PLUG-AND-RUN when access lands (docs/dark-factory/AGENT-INSTALL.md)
1. "Changes" tab appears in DevOps Agent Agent Space web app
2. Add ReleaseManagerPolicy IAM {release-manager:*} to WebApp admin role (I can do via CLI)
3. Connect GitHub App (Read&Write) + dark-factory-sandbox repo  <-- your OAuth click
4. ~1-2h repo indexing; confirm auto-review ON (maybe 2nd account-team ask)
5. Confirm real check name == aws-devops-agent/release-readiness-review
   (else tune devopsAgent.checkRunName + checkContext in values.yaml)
6. Label a fresh issue -> coder -> PR -> real DevOps check -> gate clears
   -> real Security Agent -> both green -> approve (2nd identity or simulate) -> merge+teardown

## What's DONE + LIVE (verified)
- Security Agent: real headless, proven E2E (posted to PR #39)
- Coder v0.2.2 (claude+kiro engines, aws-cli/git/zip, subdir build/test, mode-aware PR body)
- IAM applied via terraform (iam/securityagent.tf); bootstrap PreSync Job reconciles space
- Chain-gap fixes: merge.js + status.js read check-runs; devopsAgent.checkRunName pinned
- ArgoCD dark-factory-hub tracks the branch (control plane on OPENCLAW cluster)

## Known non-code gap: PR author elamaran11 can't self-approve -> need 2nd identity or simulate-approval
