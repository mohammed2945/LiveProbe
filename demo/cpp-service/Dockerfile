FROM gcc:15-bookworm AS build
WORKDIR /src
COPY demo/cpp-service/ .
RUN make

FROM debian:bookworm-slim
COPY --from=build /src/liveprobe-cpp-demo /usr/local/bin/liveprobe-cpp-demo
EXPOSE 8084
ENTRYPOINT ["/usr/local/bin/liveprobe-cpp-demo"]
