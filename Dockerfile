# Mail Router: control panel, MCP server and mail routing in one container.
#   docker compose up -d        (see compose.yaml and README)

# ---- build: dependencies (with the imapflow patch), checks, single executable
FROM oven/bun:1.3-debian AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY test ./test
ARG RUN_TESTS=1
RUN if [ "$RUN_TESTS" = "1" ]; then bun run typecheck && bun test; fi
RUN bun build src/entry.ts --compile --minify --sourcemap --outfile /out/mail-router

# ---- runtime: the executable alone, as an unprivileged user
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin mailrouter \
 && mkdir -p /data && chown mailrouter:mailrouter /data
COPY --from=build /out/mail-router /usr/local/bin/mail-router
ENV MAIL_ROUTER_HOME=/data \
    TZ=Europe/Rome
USER mailrouter
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD ["mail-router", "health"]
ENTRYPOINT ["mail-router"]
CMD ["serve"]
