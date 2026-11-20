FROM rust:1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends clang cmake pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch v1.4.1 https://github.com/n0-computer/iroh.git .
RUN cargo build --locked --release --package iroh-relay --features server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home relay
COPY --from=build /src/target/release/iroh-relay /usr/local/bin/iroh-relay
USER relay
EXPOSE 8443/tcp
ENTRYPOINT ["iroh-relay", "--config-path", "/etc/iroh/relay.toml"]
