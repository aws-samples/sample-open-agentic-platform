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
COPY agent.js ./

# Non-root, matches the SandboxTemplate securityContext (runAsUser 1000).
USER 1000

ENV CODER_PORT=8080 \
    WORKSPACE=/workspace
EXPOSE 8080

CMD ["node", "agent.js"]
