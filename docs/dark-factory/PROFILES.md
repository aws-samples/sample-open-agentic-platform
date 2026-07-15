# Dark Factory — Profiles (generic infra + app support)

> **Status:** ✅ **built** (terraform + node profiles). The profile abstraction generalizes the
> pipeline to any stack (infra *and* app microservices) without new pipeline code. Adding a
> language is a `stackProfiles:` values entry (+ a coder image with the toolchain if needed).
> **Note:** the profile NAME is resolved in the `resolve-profile` step by reading the issue's
> `dark-factory-<name>` label via the GitHub API (robust) — not by parsing the webhook in the Sensor.

## The problem

The `df-run` pipeline had stack-specific assumptions baked into two places:

1. **The coder's build/test** knew only `npm test` / `go test` / `pytest`. A Terraform PR got
   *no* real build/test (it hit the "no recognized suite — skipped" branch).
2. **deploy-test** originally only did `kubectl apply`. A Terraform PR can't be `kubectl apply`-ed.

We fixed (2) by making `deploy-test` **content-aware** (`kind = terraform | k8s`). This doc
generalizes that idea into **one concept — a profile — that drives every stack-specific step**, so
adding Java/Rust/Python is a config entry, not a code change.

## The core idea: a profile

A **profile** is a named bundle of everything the pipeline needs to know about a stack:

```yaml
# values.yaml
profiles:
  terraform:                          # dark-factory-terraform  (or -infra)
    scaffoldHint: "Terraform, AWS provider, one resource per file"
    build:   "terraform init -backend=false"
    test:    "terraform validate && terraform fmt -check -recursive"
    verifyKind: terraform             # deploy-test path
  node:                               # dark-factory-node
    scaffoldHint: "Node.js, package.json, a test script"
    build:   "npm install --no-audit"
    test:    "npm test"
    verifyKind: k8s                   # if it emits k8s/, deploy-test applies it
  java:                               # dark-factory-java
    scaffoldHint: "Spring Boot, Maven, JUnit"
    build:   "mvn -q -DskipTests package"
    test:    "mvn -q test"
    verifyKind: k8s
    coderImage: <ecr>/dark-factory-coder-java:<tag>   # image w/ the JDK+Maven
  rust:                               # dark-factory-rust
    scaffoldHint: "Cargo, axum"
    build:   "cargo build"
    test:    "cargo test"
    verifyKind: k8s
    coderImage: <ecr>/dark-factory-coder-rust:<tag>
```

Everything stack-specific is **data**. Adding a language = adding a `profiles:` entry (+ a base
image with that toolchain if the default coder image lacks it). No pipeline YAML or JS changes.

## How a profile is selected

A **second GitHub label** picks the profile: `dark-factory` (the trigger) **+** `dark-factory-<profile>`
(the stack). The Sensor reads the profile label and passes `profile=<name>` into `df-run`.

```
issue labeled: dark-factory + dark-factory-terraform
   → Sensor extracts profile=terraform
   → df-run(profile=terraform)
```

- **Default:** if only `dark-factory` is present, `profile=auto` — the coder infers the stack from
  the issue text and the pipeline falls back to detection (what we do today).
- **Why a label for the *scaffold* but auto-detect for *verify*:** the coder needs to know the stack
  **up front** (to generate idiomatic code + run the right build/test). Verification can still
  **auto-detect** from the produced files (already built as `detect-deployable`) — the profile just
  provides the default `verifyKind`. Label sets intent; detection guards reality.

## What each step does with the profile

| Step | Uses the profile for |
|---|---|
| **claim** | inject `DF_PROFILE`, `DF_BUILD_CMD`, `DF_TEST_CMD`, `DF_SCAFFOLD_HINT` into the coder VM; pick `coderImage` if the profile overrides it |
| **coder** (`entrypoint.js`) | append `scaffoldHint` to the SPEC so Claude scaffolds the right stack; run `DF_BUILD_CMD` + `DF_TEST_CMD` instead of the hardcoded npm/go/pytest guesses |
| **holdout** | unchanged — executable tests + judge are stack-agnostic |
| **security / devops** | unchanged — linters + LLM reviewer read the diff regardless of stack |
| **detect-deployable** | classify by files; profile's `verifyKind` is the default when ambiguous |
| **deploy-test** | already `kind`-driven (`terraform` → validate; `k8s` → ephemeral apply). New kinds add a `case` arm |

The **only coder change**: replace the hardcoded `buildAndTest()` language guesses with "run
`DF_BUILD_CMD` then `DF_TEST_CMD`" (falling back to the current auto-guess when unset). That single
change makes the coder stack-agnostic.

## Verification depth per profile (the honest ladder)

"Test it" means different things and costs escalate — each profile picks a rung:

| Rung | Terraform | App (node/java/rust) | Cost |
|---|---|---|---|
| **compile/validate** | `terraform validate` ✅ built | `mvn/cargo/npm build` | free |
| **unit test** | (n/a) | `mvn test` / `cargo test` / `npm test` ✅ (coder VM) | cheap |
| **deploy/run** | `terraform plan` (needs read creds) | build image → run → probe, or k8s apply ✅ built | medium |
| **real provision** | `terraform apply` in sandbox acct | deploy to ephemeral EKS | high, opt-in |

Profiles declare how far up the ladder they go; the default stops at validate/unit-test (free/cheap,
un-gameable) and higher rungs are opt-in (creds / real infra).

## Scope recommendation (avoid overkill)

**Build now (high leverage):**
1. The **profile abstraction** — label→profile, profile carries scaffoldHint + build/test + verifyKind.
2. Make the **coder run `DF_BUILD_CMD`/`DF_TEST_CMD`** (the one real code change).
3. Wire **2 profiles**: `terraform` (validate — done) and `node` (npm — works) to prove the frame.

**Defer until a real issue needs it (cheap to add later):**
- `java` / `rust` profiles — just a `profiles:` entry + a coder base image with the toolchain.
- **App "runs locally"** (build container → run → curl) — real work (image build from untrusted
  code); separate phase.
- **`terraform plan`/`apply`** and **ephemeral-EKS** rungs — credential/real-infra decisions.

The frame is the leverage. Individual profiles are YAML someone adds when a real issue demands them —
so we don't pre-build Java/Rust speculatively.
