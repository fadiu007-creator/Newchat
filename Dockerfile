FROM node:24-trixie-slim
COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip git ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir -p /workspace && chown -R node:node /workspace
USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
