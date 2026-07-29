# LiveProbe on Kubernetes

This guide covers connecting services running in a Kubernetes cluster to an
existing LiveProbe broker. For a laptop or a single VM, use the
[client setup guide](client-setup.md) instead; the language sections there still
apply and are not repeated here.

Two things work differently in a cluster, and both catch people out:

- **The native agent runs once per node, not once per service.** It is a
  DaemonSet that observes every pod on its node, so paths and allowlists refer
  to the target's *in-container* filesystem, not the node's.
- **A non-root pod cannot be granted capabilities the usual way.** The obvious
  manifest fails silently — the agent starts, sees every process, reads none of
  them, and reports nothing. See step 4.

Verified on Kubernetes 1.36 (k3s) on an Ubuntu 24.04 x86-64 node, kernel 6.17,
against unmodified upstream container images.

---

## Before you start: check the node

```sh
uname -m                                    # x86_64 — the native backend is x86-64 only
test -r /sys/kernel/btf/vmlinux && echo "BTF ok"
mountpoint -q /sys/kernel/tracing || sudo mount -t tracefs tracefs /sys/kernel/tracing
```

The other precondition — that your kernel's verifier accepts the BPF program —
needs the image, so it is step 2 rather than step 0.

**Node image:** verified on Ubuntu. On GKE that means
`--image-type=UBUNTU_CONTAINERD`. Container-Optimized OS has not been tested;
it ships BTF, so it may work now that the agent is delivered as an image rather
than compiled onto the node, but treat that as unverified.

---

## 1. Build the agent image

There is no published image yet. Both binaries go in one image and the DaemonSet
runs them as separate containers, which preserves the privilege split described
in the client setup guide.

`deploy/k8s/native-agent/Dockerfile` in this repository builds it. Two details in
it matter and are easy to lose if you write your own:

```dockerfile
# Runs the BPF audit before building. Do not replace with a bare cargo build.
RUN make native-release

# Without this the agent cannot read other processes. See step 4.
RUN setcap cap_sys_ptrace=ep /usr/local/bin/liveprobe-native-agent
```

Build for the node's architecture. Building x86-64 images on an Apple Silicon
machine works, but do not try to *test* against them locally — Docker runs amd64
images under Rosetta and `/proc/<pid>/exe` then points at the translator instead
of your service, so discovery results are meaningless.

## 2. Check the kernel accepts the BPF program

Thirty seconds here saves an afternoon. The program must pass your kernel's
verifier, and that is a property of the kernel rather than of your manifests —
no Kubernetes configuration will work around a rejection.

The simplest check is the DaemonSet itself: deploy step 4 and read the loader
container's log. The loader loads the BPF program before it does anything else,
so a rejection is the first thing it prints and the container will not stay up.

```sh
kubectl logs -n liveprobe ds/liveprobe-native-agent -c loader
```

A rejection is unmistakable — a long instruction dump ending in
`prog 'liveprobe_snapshot': failed to load: -EACCES`, naming the offending
instruction. A loader container sitting at `Running` with an empty log means the
verifier accepted the program.

To check before deploying anything, run the loader directly on a node. **Use the
container runtime's Kubernetes namespace**, or it will not find the image:

```sh
# k3s
sudo k3s ctr run --rm --privileged "$IMAGE" preflight \
  /usr/local/bin/liveprobe-bpf-loader /tmp/preflight.sock 0 0 /bin/true

# containerd generally
sudo ctr -n k8s.io run --rm --privileged "$IMAGE" preflight \
  /usr/local/bin/liveprobe-bpf-loader /tmp/preflight.sock 0 0 /bin/true
```

Plain `sudo ctr run` uses containerd's `default` namespace, where the image is
not present, and fails in a way that looks nothing like a verifier problem.
`/bin/true` is a placeholder allowlist entry; nothing is attached. It stays
running once loaded — Ctrl-C to exit.

## 3. Create the credential as a Secret

Native agents use their own credential class, scoped to an explicit service
allowlist:

```sh
curl --fail --silent --show-error \
  -H "Authorization: Bearer ${LIVEPROBE_API_KEY}" \
  -H "Content-Type: application/json" \
  --data '{"agentId":"node-agent","allowedServiceIds":["user-service"],"label":"cluster"}' \
  "${BROKER_URL}/v1/native-credentials"
```

The `apiKey` is shown once.

```sh
kubectl create namespace liveprobe
kubectl create secret generic liveprobe-native-credential -n liveprobe \
  --from-literal=credential='lp_native_...'
```

Confirm pods can actually reach the broker before blaming the agent — pod egress
often differs from your laptop's:

```sh
kubectl run egress --rm -i --restart=Never --image=curlimages/curl -- \
  -sS -o /dev/null -w '%{http_code}\n' "${BROKER_URL}/healthz"
```

## 4. Deploy the DaemonSet

Start from `deploy/k8s/native-agent/daemonset.yaml`. Three parts of it are
load-bearing.

**`hostPID: true`.** procfs is per-PID-namespace, so this is what lets the pod's
own `/proc` list every process on the node. Without it the agent discovers
nothing. No separate proc-root mount is needed.

**The capability pairing.** This is the one that fails silently:

```yaml
securityContext:
  runAsUser: 10001
  runAsGroup: 10001          # must match the gid passed to the loader
  allowPrivilegeEscalation: true
  capabilities:
    add: ["SYS_PTRACE"]
    drop: ["ALL"]
```

Kubernetes has no ambient-capability support, so for a non-root user
`capabilities.add` populates only the *bounding* set — `CapPrm` and `CapEff`
stay empty and the capability is never held. The `setcap` from step 1 is what
actually grants it, and `allowPrivilegeEscalation: true` is required or
`NO_NEW_PRIVS` blocks the transition. It does not make the agent root: the
bounding set is still only `SYS_PTRACE`, so that is the one capability it can
ever hold, and it still cannot load BPF.

Verify against the agent process, not a shell you `exec` into — the file
capability applies to the agent binary alone:

```sh
pid=$(pgrep -f 'liveprobe-native-agent /etc')
sudo grep -E '^Cap(Prm|Eff)' /proc/$pid/status
# CapPrm: 0000000000080000
# CapEff: 0000000000080000     <- CAP_SYS_PTRACE. Zeros here mean step 1 or 4 is wrong.
```

**Paths are in-container.** Both the config and the loader allowlist name the
executable as *the target process sees it*, not as it appears on the node:

```yaml
# ConfigMap
{ "serviceId": "user-service", "language": "cpp",
  "executablePath": "/usr/local/bin/UserService" }

# Loader args — the attach allowlist. It will attach to nothing else.
args: ["/run/liveprobe/loader.sock", "10001", "10001",
       "/usr/local/bin/UserService"]
```

If you are used to the host install, this is the change most likely to trip you
up. To find the right value:

```sh
sudo readlink /proc/<pid>/exe    # from the node, with hostPID visibility
```

## 5. Confirm the service appears

```sh
curl -sS -H "Authorization: Bearer ${LIVEPROBE_API_KEY}" \
  "${BROKER_URL}/v1/services" | jq '.services[] | select(.backend=="native-ebpf")'
```

The service registers once the agent finds a running process whose executable
matches. Then place a probe from your MCP client as usual.

---

## In-process languages in a cluster

Node and Python need nothing cluster-specific: install the package, set
`BROKER_URL`, `LIVEPROBE_API_KEY` and `GIT_COMMIT` from a Secret and the
Downward API or your image build.

**The JVM bridge belongs in the same pod as a sidecar.** Containers in a pod
share a network namespace, so JDWP stays on `127.0.0.1:5005` and is never
exposed — which is exactly the property the client setup guide asks for:

```yaml
containers:
  - name: inventory
    args: ["-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:5005",
           "-jar", "/app/application.jar"]
  - name: liveprobe-bridge
    args: ["--service", "inventory-service", "--attach", "127.0.0.1:5005",
           "--broker", "$(BROKER_URL)", "--commit", "$(GIT_COMMIT)"]
```

Do not publish 5005 through a Service, and do not use `hostNetwork` for the
target pod.

---

## Troubleshooting

Ordered by how often they occur and how misleading the symptom is.

| Symptom | Cause |
| --- | --- |
| Agent runs, logs nothing, no services appear | `CapEff` is zero. Step 3 — the `setcap` / `allowPrivilegeEscalation` pairing. This is the most common failure and it produces no error message. |
| Probe reports `armed` forever, returns no data | The line may genuinely not be executing — but check `get_safety_overview` first. An `evidence` block with `rejectedBatches` above zero means the agent's evidence is being discarded, not that the line is cold. |
| Loader exits at startup with a verifier dump | The kernel refused the BPF program. Nothing configuration-related; see the pre-flight check above. |
| `local-policy-denied: executable is not allowlisted` | The loader's allowlist has a node path where it needs the in-container path. |
| Service never appears, agent otherwise healthy | No running process matches `executablePath`, or `hostPID` is missing. |
| `source-file-not-found` on a path you know is right | The file was found; that line has no code. Under optimization the compiler often attributes a statement to a different line than you would expect. Try adjacent lines. |
| Permission denied on the loader socket | `runAsGroup` does not match the gid passed to the loader, which chowns the socket `root:<gid>` mode 0660. |
| Native services show no `commitSha` | Expected. Native agents do not report a deployed commit, unlike the in-process SDKs. `commit_hash` on a probe is still required but is only audit metadata. |

### Before you trust a captured value

Line resolution and value capture are different problems, and optimization
affects them differently. C++ built with **GCC** at `-O3` returned correct values
in every measurement; Rust at any `opt-level` above 0 returned a stale stack slot
for one variable while the variable beside it was correct, with nothing in the
output distinguishing them. **clang**-built C++ has not been measured and shares
LLVM's backend with Rust, so do not assume the GCC result covers it.

Read `native-language-evaluation.md` before relying on native values in an
optimized Rust build. It is short and it will save you from acting on a
confident-looking wrong number.

---

## Teardown

```sh
kubectl delete -f deploy/k8s/native-agent/daemonset.yaml
kubectl delete secret liveprobe-native-credential -n liveprobe
curl -X DELETE -H "Authorization: Bearer ${LIVEPROBE_API_KEY}" \
  "${BROKER_URL}/v1/native-credentials/<credential-id>"
```

Revoke the credential even for a torn-down cluster; it is scoped to services,
not to the agent that used it.
