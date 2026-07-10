# No Manual Fixes

All changes to the cluster MUST go through git and ArgoCD. Never apply fixes manually via kubectl apply, kubectl patch, kubectl annotate, or helm template | kubectl apply.

- If ArgoCD hasn't synced, wait for the repo cache to refresh or trigger a hard refresh — do NOT bypass it by applying manifests directly.
- Diagnosis with kubectl get/describe/logs is fine.
- Mutations (apply, patch, delete, create, annotate, label) are ONLY for diagnosis cleanup (e.g., deleting a stuck job finalizer) — never as the fix itself.
- The fix must always be a git commit pushed to the branch, then ArgoCD reconciles it.
