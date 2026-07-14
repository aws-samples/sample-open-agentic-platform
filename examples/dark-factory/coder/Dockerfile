# Dark Factory coder image — runs INSIDE the Kata micro-VM sandbox.
#
# Bundles the in-VM agent + the toolchains a coder run needs (git, node, the
# Claude Code CLI). This is untrusted-code territory: the image carries no
# credentials — secrets are injected at runtime via projected tmpfs (0400) and
# model access is only through Bifrost. Keep it lean and pinned.
FROM public.ecr.aws/docker/library/node:20-alpine

# Toolchains for build/test across common stacks + git for checkout/push.
# (Extend per the repos the factory targets; kept minimal for P1.)
RUN apk add --no-cache git bash python3 py3-pip go

# Claude Code headless CLI (primary coder profile). Pinned via npm.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
# entrypoint.js — env-driven Flow B P1 coder (auto-runs on VM start, self-reports
# via GitHub). agent.js — the earlier HTTP-server reference (kept for reuse).
COPY entrypoint.js agent.js ./

# Non-root, matches the SandboxTemplate securityContext (runAsUser 1000).
USER 1000

ENV WORKSPACE=/workspace

# Baked into the Flow A SandboxTemplate as the coder image. On VM start it reads
# the DF_* env injected by the SandboxClaim, implements + tests, pushes the
# branch, opens the PR, and sets the dark-factory/implementation commit status.
CMD ["node", "entrypoint.js"]
