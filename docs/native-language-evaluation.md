# Native backend: Rust and C++ evaluation

Measured on the Kubernetes demo cluster on 2026-07-29, against services running
under live load. Every value below was checked against the service's own output,
not assumed. Companion to `docs/k8s-dogfood-findings.md`.

The short version: **the native backend works, and the quality of what it
returns is decided almost entirely by which compiler produced the DWARF.** C++
built by GCC at `-O3` is reliable. Rust built by LLVM is reliable only at
`opt-level = 0`.

---

## Why they differ: location lists

This is the whole story, and it is visible in the debug info.

A variable's `DW_AT_location` can take two forms. A **location list** carries PC
ranges, so it can say "in register X between these addresses, in stack slot Y
between those". A bare **exprloc** gives one location with no range, implicitly
claiming validity everywhere in scope.

```
C++  (GCC 5.4, -O3)   user_id    DW_AT_location : 0xc23be (location list)
Rust (LLVM,    -O3)   tier_code  DW_AT_location : 2 byte block: 91 10 (DW_OP_fbreg: 16)
```

The agent handles both correctly — `attribute_expression_at_pc` in
`native/agent/src/dwarf/mod.rs` walks a location list and selects the entry whose
range contains the probe address, returning `OptimizedOut` when none does. Given
a location list it cannot pick a stale location.

Given a bare `DW_OP_fbreg`, there is nothing to check. If the variable actually
lives in a register at that instruction and its home stack slot has not been
written, the agent reads the slot and returns whatever is in it. That is not a
bug in the agent; it is the agent being told something untrue.

---

## C++ — reliable at full optimization

Target: `deathstarbench/social-network-microservices`, unmodified published
image. Producer: `GNU C++14 5.4.0 -g -O3 -std=gnu++14 -fstack-protector-strong`.
Probe: `ComposePostHandler.h:135`, inside `_ComposeCreaterHelper`.

| Watch | Reported | Verdict |
| --- | --- | --- |
| `user_id` | 897, 84, 684, 544, 778, 431 | ✅ every value inside `[0, 962]`, the exact user count of the seeded `socfb-Reed98` dataset |
| `req_id` | 337298795568605440, 553815915779310100, … | ✅ large distinct int64, matching DSB's random request IDs |

Six independent captures across two runs, no wrong values. The `user_id` range
check is the strongest validation available here: the probe never once returned a
value outside the dataset, which a stale stack slot would have violated almost
immediately.

**Assessment: production-usable as-is.** Stock `-g -O3` GCC binaries need no
rebuild, no flag changes, and no relaxed optimization.

### C++ caveats

- **Line attribution moves under optimization.** A probe on
  `ComposePostHandler.h:134` — the line the call visibly starts on — failed,
  because GCC attributed the call to 135. See finding 8; the reported error
  (`source-file-not-found`) is also misleading.
- Only the **eleven `/usr/local/bin/*Service` binaries** carry DWARF. Anything
  probed must be in both the agent config and the loader allowlist.
- GCC 5.4 is old. Nothing here is evidence about clang-built C++, which uses the
  same LLVM backend as Rust and may well behave like it.

---

## Rust — reliable only unoptimized

Target: a purpose-built service, `debug = 2, strip = false` per
`docs/client-setup.md`. Probe: `rust_orders_service.rs:11`. Ground truth is the
service's own stdout on every line.

| Build | `fee_cents` (fbreg +8) | `tier_code` (fbreg +16) | Verdict |
| --- | --- | --- | --- |
| `opt-level = 0` | 51 ✅ | **7, 3, 7** ✅ alternates exactly as printed | correct |
| `opt-level = 1` | 51 ✅ | **140722420280128** ❌ constant stack address | wrong |
| `opt-level = 3` (documented release default) | 53 ✅ | **140735268890816** ❌ constant stack address | wrong |

The service prints `tier=3` and `tier=7` alternately; the probe returned the same
stack address on every hit. `fee_cents` was correct at every level — its home
slot happens to be live at that instruction — which is precisely what makes this
dangerous: a correct value and a fabricated one sit side by side, formatted
identically.

`opt-level = 1` was tested specifically to see whether a middle setting would do,
and it does not. The threshold is between 0 and 1, not somewhere near 3.

### What to do about Rust

Ordered by how much they actually help.

1. **Probe values you can corroborate.** The failure is silent, so the only
   reliable defence today is a second source: the service's own logs, a metric, a
   second variable with a known relationship. Never act on a single unverified
   native scalar from an optimized Rust build.
2. **Prefer function parameters read at entry, not mid-body locals.** At a
   function's first instruction the ABI guarantees where arguments are, and the
   DWARF agrees. The deeper into a function a probe sits, the more the home slot
   diverges from reality.
3. **Sanity-filter the value.** A scalar in the x86-64 stack range
   (roughly `0x7f0000000000`–`0x800000000000`) is almost never a business value.
   Both wrong readings above are in that range; a cheap check would have caught
   both.
4. **Mark bare-`fbreg` reads low-confidence.** When a variable's only location is
   an exprloc and `DW_AT_producer` shows an optimizing build, the agent knows it
   is guessing. It already returns `variable-not-found` when it cannot resolve —
   it needs a third state between "here is the value" and "not found".
5. **Ship a documented `[profile.probe]`** for services intended to be probed:

   ```toml
   [profile.probe]
   inherits = "release"
   opt-level = 0        # anything higher makes locals unreliable
   debug = 2
   strip = false
   ```

   State the trade-off honestly rather than implying `debug = 2` is sufficient.
6. **Worth investigating:** whether `-Z` / newer rustc emits location lists more
   readily, and whether `DW_OP_entry_value` (which LLVM does emit for call-site
   parameters) can recover argument values the home slot has lost. That would fix
   the common case without giving up optimization.

**Assessment: usable for line-hit and counter probes at any optimization level;
trustworthy for value capture only at `opt-level = 0`.**

---

## Correction to an earlier conclusion

An intermediate result in this session claimed Rust probes at `opt-level` 1 and 2
"arm but never fire". That was wrong, and the cause was finding 10 — a poisoned
ingest pipeline dropping every batch, unrelated to Rust or optimization. Once the
agent was restarted, the same builds delivered events immediately. The table
above is from clean runs after that was understood.
