# Native Linux demos

These intentionally buggy Rust and C++ HTTP services are native eBPF test
targets. They are not production services. Build and run them on the same Linux
host as the native agent so `/proc/<pid>/exe`, build IDs, DWARF, and uprobe file
offsets all describe the same filesystem.

```sh
cargo build --manifest-path demo/rust-service/Cargo.toml --release
make -C demo/cpp-service
demo/rust-service/target/release/liveprobe-rust-demo &
demo/cpp-service/liveprobe-cpp-demo &
curl http://127.0.0.1:8083/
curl http://127.0.0.1:8084/
```

Both release builds retain DWARF and GNU build IDs while using optimization.
The source comments identify stable count, snapshot, log, metric, fan-out, and
optimized-out test locations. Docker Compose's `native` profile only builds
and runs target binaries; Docker/Kubernetes attachment is not supported by the
current native backend. Mandatory eBPF integration tests use host processes.
Granting `privileged` to application containers is neither necessary nor
supported.
