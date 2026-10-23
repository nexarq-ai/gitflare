FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep coreutils util-linux chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji && rm -rf /var/lib/apt/lists/*
ENV GITFLARE_CHROMIUM=/usr/bin/chromium
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
WORKDIR /workspace
CMD ["sleep", "infinity"]
