# Dark Factory orchestrator — small, non-root Node image.
# Purpose-built (not npm-install-at-start) so the trusted component is
# auditable and starts fast. The orchestrator holds credentials and talks to
# the Kubernetes API + GitHub, so it stays minimal.
FROM public.ecr.aws/docker/library/node:20-alpine

WORKDIR /app

# Install deps first for layer caching. Only @kubernetes/client-node.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY lib ./lib

# Non-root: the orchestrator needs no privileges beyond its ServiceAccount RBAC.
USER 1000

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
