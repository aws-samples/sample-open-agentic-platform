# Dark Factory — AWS Frontier Agent install runbook

The Dark Factory reviews are the **real AWS Security Agent + AWS DevOps Agent**. Almost everything
is automated (GitOps + Terraform + a PreSync bootstrap Job). **One thing cannot be automated: the
GitHub App authorization**, because it is an OAuth consent — a human must grant an AWS app access to
the GitHub org in a browser. No API or token can fabricate that consent (that is the whole point of
OAuth). This page is the one-time human runbook.

> **TL;DR for the installer:** click one link, install the app on the repo, done. ~5 minutes.

---

## What's already automated (you do NOT do these)

| Piece | How | Where |
|---|---|---|
| IAM (OIDC provider, service role, IRSA role, S3 diff bucket) | Terraform | `iam/securityagent.tf` (`terraform apply`) |
| Agent Space + Application | idempotent ArgoCD **PreSync Job** | `templates/06-securityagent-bootstrap.yaml` → writes Secret `argo/dark-factory-securityagent` |
| Security Agent code review | **fully headless** — S3 diff API via IRSA, **no GitHub App needed** | `scripts/security-agent.sh` |
| DevOps→Security ordering, gating, sticky status | Argo `df-run` DAG | `templates/20-workflowtemplate-df-run.yaml` |

---

## The one manual step — connect the repo to the AWS DevOps Agent (GitHub App)

**Why only DevOps?** The Security Agent runs headlessly over an S3-staged diff, so it needs **no**
GitHub App. The **DevOps Agent** release-readiness review has **no headless code-review API** — it only
runs via its GitHub App (auto-reviews each PR and posts a check-run) or the IDE plugin. So the DevOps
Agent's GitHub App must be installed once on the org/repo.

### Steps (installer, ~5 min)

1. **Sign in** to the AWS console as an admin of account **`940019131157`**, region **`us-west-2`**,
   and to GitHub as an **org owner** of the target org (`elamaran11`, repo `dark-factory-sandbox`).

2. Open the **AWS DevOps Agent** console → your Agent Space → **Capabilities** → **GitHub**
   (or generate the install link via the CLI — see "Regenerating the link" below).

3. Click **Connect GitHub / Install App**. GitHub shows the app-install consent screen. Choose the
   org, select **Only the `dark-factory-sandbox` repo** (or All repos), and click **Install &
   Authorize**. This is the OAuth consent — the part that must be a human.

4. In the DevOps Agent **Code Review and Automated Testing** settings for the repo, ensure:
   - **Auto trigger change review** = ON (reviews every PR)
   - **Automated verification testing** = ON (optional; builds+tests in the AWS-managed env)
   - **Runtime role** = (optional) an IAM role for private-registry access during builds.

5. **Done.** From now on the DevOps Agent reviews every PR and posts a check-run. The Dark Factory
   `devops-gate` step watches for that check (context matches `devopsAgent.checkContext`), and on a
   clear verdict applies the `needs-security-review` label → the Security Agent step runs.

### Regenerating the install link (CLI)

The Security Agent's GitHub App install URL + CSRF state can be minted with:

```bash
aws securityagent initiate-provider-registration --provider GITHUB --region us-west-2
# → { "redirectTo": "https://github.com/apps/aws-security-agent/installations/new",
#     "csrfState": "<token>" }
```

Open `redirectTo` in a browser to install. *(We use the Security Agent headlessly, so this is only
needed if you also want its GitHub-App / PR-comment path. The DevOps Agent install is driven from the
DevOps Agent console the same way.)*

---

## How to verify the install worked

```bash
# 1. Open a test PR in the connected repo, then within ~10 min:
gh api repos/elamaran11/dark-factory-sandbox/commits/<PR_HEAD_SHA>/check-runs \
  --jq '.check_runs[].name'          # expect a DevOps Agent check-run to appear

# 2. In a df-run, the devops-gate step logs "AWS DevOps Agent CLEARED" and the
#    needs-security-review label appears on the PR → security-agent step runs.
```

Until the app is connected, `devops-gate` reports **not-cleared** and the Security Agent step is
**skipped** — the pipeline **never fakes a DevOps pass**. That's the intended safe default.

---

## What I need from you / your colleague (the human bits)

1. **Install + authorize the AWS DevOps Agent GitHub App** on the org/repo (steps above). This is the
   only irreducibly-human action.
2. Confirm the **`devopsAgent.checkContext`** regex in `values.yaml` matches the exact check-run name
   the DevOps Agent posts (visible on the first reviewed PR). Default:
   `(?i)(devops[- ]?agent|release[- ]?readiness)`. Tune if the real context differs.
3. (If using the coding-agent plugin path instead of the App) install the **DevOps Agent Claude Code
   plugin** via `aim plugins install <plugin>` — needs Midway; not usable from the credential-less
   Kata VM, so the GitHub-App path is the default.

Everything else — IAM, agent space, the Security Agent review, ordering, gating — is automated.
