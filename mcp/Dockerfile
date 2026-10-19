# The ALSxaPlus MCP server. Build context: mcp/
# aws-lc-sys (TLS for the Bedrock client) needs cmake and a C compiler, which this builder image provides.
FROM rust:1.99-bookworm AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends cmake \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations
RUN cargo build --release --locked --bin alsxaplus-mcp \
    && strip target/release/alsxaplus-mcp

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home alsxaplus
COPY --from=build /app/target/release/alsxaplus-mcp /usr/local/bin/alsxaplus-mcp
USER alsxaplus
ENV PORT=8081 RUST_LOG=info
EXPOSE 8081
CMD ["alsxaplus-mcp"]
