FROM rust:1.93-bookworm AS build
WORKDIR /src
COPY demo/rust-service/ .
RUN cargo build --release && readelf --notes target/release/liveprobe-rust-demo | grep -q 'Build ID:'

FROM debian:bookworm-slim
COPY --from=build /src/target/release/liveprobe-rust-demo /usr/local/bin/liveprobe-rust-demo
EXPOSE 8083
ENTRYPOINT ["/usr/local/bin/liveprobe-rust-demo"]
