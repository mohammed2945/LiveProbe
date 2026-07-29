# Native eBPF backend for Kubernetes, as one image containing both binaries.
#
# The client-setup guide installs these by compiling on each host, which is
# impossible on a GKE node: Container-Optimized OS has a read-only /usr and no
# package manager, and even on Ubuntu nodes it means a toolchain per node. The
# DaemonSet runs this image instead, with the loader and agent as separate
# containers so the privilege split survives the move to Kubernetes.
#
# The runtime base must stay aligned with the node image (Ubuntu) so that the
# glibc and libbpf the binaries link against are the ones present at run time.

FROM rust:1-bookworm AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config clang llvm lld bpftool \
      libbpf-dev libelf-dev zlib1g-dev dwarves \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY native ./native
COPY Makefile ./Makefile

# `make native-release` runs the BPF audit (which rejects bpf_probe_write_user
# in source and in the compiled object) before building the workspace. Keep
# using the make target rather than a bare cargo build so the audit cannot be
# skipped by accident.
RUN make native-release

FROM ubuntu:24.04 AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
      libelf1 zlib1g ca-certificates libcap2-bin \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home --shell /usr/sbin/nologin --uid 10001 liveprobe

COPY --from=build /src/native/target/release/liveprobe-bpf-loader /usr/local/bin/
COPY --from=build /src/native/target/release/liveprobe-native-agent /usr/local/bin/

# The agent must read /proc/<pid>/exe and /proc/<pid>/root for processes it does
# not own, which needs CAP_SYS_PTRACE. A pod's `capabilities.add` only populates
# the *bounding* set for a non-root user — CapPrm and CapEff stay empty and every
# read fails — because Kubernetes has no ambient-capability support. A file
# capability is what actually grants it, and it requires
# allowPrivilegeEscalation: true on the container so NO_NEW_PRIVS does not block
# the transition. The agent still holds no BPF privilege, so the split with the
# loader is unchanged.
RUN setcap cap_sys_ptrace=ep /usr/local/bin/liveprobe-native-agent

# No default user: the loader container overrides to root, the agent container
# runs as liveprobe. Setting it here would silently make the loader unprivileged.
