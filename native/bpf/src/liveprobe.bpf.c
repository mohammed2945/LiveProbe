#include <linux/bpf.h>
#include <linux/ptrace.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include "liveprobe.h"

char LICENSE[] SEC("license") = "Dual BSD/GPL";

// Stops the compiler reloading a value from map memory after it has been range
// checked, which would discard the verifier's knowledge of its bounds.
#ifndef barrier_var
#define barrier_var(var) asm volatile("" : "+r"(var))
#endif

struct liveprobe_probe_state {
    __u32 generation;
    __u32 disabled;
    __u64 captures;
    __u64 accepted_raw_hits;
};
struct liveprobe_rate_state { __u64 packed_second_tokens; };

struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 4096); __type(key, __u64); __type(value, struct liveprobe_capture_plan); } probe_plans SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 4096); __type(key, __u64); __type(value, struct liveprobe_probe_state); } probe_state SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_PERCPU_HASH); __uint(max_entries, 4096); __type(key, __u64); __type(value, __u64); } raw_hit_counters SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_PERCPU_HASH); __uint(max_entries, 4096); __type(key, __u64); __type(value, __u64); } capture_counters SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 4096); __type(key, __u64); __type(value, struct liveprobe_rate_state); } rate_limit_state SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_PERCPU_HASH); __uint(max_entries, 4096); __type(key, __u64); __type(value, __u64); } dropped_event_counters SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_PERCPU_HASH); __uint(max_entries, 4096); __type(key, __u64); __type(value, __u64); } counter_aggregates SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_RINGBUF); __uint(max_entries, 1 << 22); } events SEC(".maps");

static __always_inline void increment(void *map, __u64 cookie) {
    __u64 one = 1, *value = bpf_map_lookup_elem(map, &cookie);
    if (value) __sync_fetch_and_add(value, 1); else bpf_map_update_elem(map, &cookie, &one, BPF_NOEXIST);
}

// Selecting a pt_regs field by a runtime index invites clang to compute
// `ctx + offset[reg]` and issue one load through that pointer. The verifier
// refuses to dereference a ctx pointer carrying a computed offset
// ("dereference of modified ctx ptr"), so each case must produce its own load
// with the offset encoded in the instruction. Fencing the loaded value forces
// that: the reads can no longer be folded into a single pointer-select.
#define LIVEPROBE_CTX_FIELD(ctx, field) ({ \
    unsigned long __value = (ctx)->field;  \
    barrier_var(__value);                  \
    __value;                               \
})

static __always_inline unsigned long register_value(struct pt_regs *ctx, __u8 reg) {
#if defined(__TARGET_ARCH_x86)
    switch (reg) {
    case 0: return LIVEPROBE_CTX_FIELD(ctx, rax); case 1: return LIVEPROBE_CTX_FIELD(ctx, rdx);
    case 2: return LIVEPROBE_CTX_FIELD(ctx, rcx); case 3: return LIVEPROBE_CTX_FIELD(ctx, rbx);
    case 4: return LIVEPROBE_CTX_FIELD(ctx, rsi); case 5: return LIVEPROBE_CTX_FIELD(ctx, rdi);
    case 6: return LIVEPROBE_CTX_FIELD(ctx, rbp); case 7: return LIVEPROBE_CTX_FIELD(ctx, rsp);
    case 8: return LIVEPROBE_CTX_FIELD(ctx, r8); case 9: return LIVEPROBE_CTX_FIELD(ctx, r9);
    case 10: return LIVEPROBE_CTX_FIELD(ctx, r10); case 11: return LIVEPROBE_CTX_FIELD(ctx, r11);
    case 12: return LIVEPROBE_CTX_FIELD(ctx, r12); case 13: return LIVEPROBE_CTX_FIELD(ctx, r13);
    case 14: return LIVEPROBE_CTX_FIELD(ctx, r14); case 15: return LIVEPROBE_CTX_FIELD(ctx, r15);
    default: return 0;
    }
#else
    return reg < 8 ? LIVEPROBE_CTX_FIELD(ctx, regs[reg]) : 0;
#endif
}

static __always_inline int add_user_offset(unsigned long *value, __s32 offset) {
#if defined(__TARGET_ARCH_x86)
    const unsigned long user_limit = 0x00007fffffffffffULL;
#else
    const unsigned long user_limit = ~0UL >> 1;
#endif
    if (offset >= 0) {
        unsigned long addition = (__u32)offset;
        if (*value > user_limit || addition > user_limit - *value) return 0;
        *value += addition;
    } else {
        unsigned long subtraction = (unsigned long)(-(__s64)offset);
        if (*value < subtraction) return 0;
        *value -= subtraction;
    }
    return *value > 0 && *value <= user_limit;
}

static __always_inline int valid_user_read(unsigned long value, __u8 width) {
#if defined(__TARGET_ARCH_x86)
    const unsigned long user_limit = 0x00007fffffffffffULL;
#else
    const unsigned long user_limit = ~0UL >> 1;
#endif
    return value > 0 && value <= user_limit && width <= user_limit - value + 1;
}

static __always_inline int allowed(struct liveprobe_capture_plan *plan, __u64 cookie, __u32 pid) {
    if (!plan || plan->abi_version != LIVEPROBE_ABI_VERSION || plan->pid != pid) return 0;
    if (plan->cgroup_id && plan->cgroup_id != bpf_get_current_cgroup_id()) return 0;
    struct liveprobe_probe_state *state = bpf_map_lookup_elem(&probe_state, &cookie);
    if (state && (state->disabled || state->generation != plan->generation)) return 0;
    return 1;
}

static __always_inline int reserve_hit(struct liveprobe_capture_plan *plan, __u64 cookie) {
    struct liveprobe_probe_state *state = bpf_map_lookup_elem(&probe_state, &cookie);
    if (!state) return 0;
    __u64 previous = __sync_fetch_and_add(&state->captures, 1);
    if (previous >= plan->hit_limit) { __sync_fetch_and_sub(&state->captures, 1); return 0; }
    return 1;
}

static __always_inline int sample_hit(struct liveprobe_capture_plan *plan, __u64 cookie) {
    struct liveprobe_probe_state *state = bpf_map_lookup_elem(&probe_state, &cookie);
    if (!state || !plan->sample_every) return 0;
    __u64 sequence = __sync_fetch_and_add(&state->accepted_raw_hits, 1) + 1;
    return plan->sample_every == 1 || sequence % plan->sample_every == 0;
}

static __always_inline int consume_token(struct liveprobe_capture_plan *plan, __u64 cookie) {
    struct liveprobe_rate_state *rate = bpf_map_lookup_elem(&rate_limit_state, &cookie);
    if (!rate) {
        __u64 second = bpf_ktime_get_ns() / 1000000000ULL;
        struct liveprobe_rate_state initial = {
            .packed_second_tokens = (second << 32) | plan->burst
        };
        bpf_map_update_elem(&rate_limit_state, &cookie, &initial, BPF_NOEXIST);
        rate = bpf_map_lookup_elem(&rate_limit_state, &cookie);
        if (!rate) return 0;
    }
    __u64 now_second = bpf_ktime_get_ns() / 1000000000ULL;
#pragma unroll
    for (int attempt = 0; attempt < 8; attempt++) {
        __u64 previous = rate->packed_second_tokens;
        __u64 last_second = previous >> 32;
        __u64 tokens = (__u32)previous;
        if (now_second > last_second) {
            __u64 added = (now_second - last_second) * plan->refill_per_second;
            tokens += added;
            if (tokens > plan->burst) tokens = plan->burst;
            last_second = now_second;
        }
        if (!tokens) return 0;
        __u64 next = (last_second << 32) | (__u32)(tokens - 1);
        if (__sync_val_compare_and_swap(&rate->packed_second_tokens, previous, next) == previous)
            return 1;
    }
    return 0;
}

SEC("uprobe/liveprobe_count")
int liveprobe_count(struct pt_regs *ctx) {
    __u64 cookie = bpf_get_attach_cookie(ctx);
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 pid = pid_tgid >> 32;
    struct liveprobe_capture_plan *plan = bpf_map_lookup_elem(&probe_plans, &cookie);
    increment(&raw_hit_counters, cookie);
    if (!allowed(plan, cookie, pid) || !reserve_hit(plan, cookie)) return 0;
    increment(&counter_aggregates, cookie);
    increment(&capture_counters, cookie);
    return 0;
}

SEC("uprobe/liveprobe_snapshot")
int liveprobe_snapshot(struct pt_regs *ctx) {
    __u64 cookie = bpf_get_attach_cookie(ctx);
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 pid = pid_tgid >> 32;
    struct liveprobe_capture_plan *plan = bpf_map_lookup_elem(&probe_plans, &cookie);
    increment(&raw_hit_counters, cookie);
    if (!allowed(plan, cookie, pid) || !sample_hit(plan, cookie) || !consume_token(plan, cookie) || !reserve_hit(plan, cookie)) return 0;

    struct liveprobe_raw_event *event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
    if (!event) {
        increment(&dropped_event_counters, cookie);
        struct liveprobe_probe_state *state = bpf_map_lookup_elem(&probe_state, &cookie);
        if (state) __sync_fetch_and_sub(&state->captures, 1);
        return 0;
    }
    __builtin_memset(event, 0, sizeof(*event));
    event->abi_version = LIVEPROBE_ABI_VERSION; event->slot_count = plan->slot_count;
    event->generation = plan->generation; event->pid = pid; event->tid = (__u32)pid_tgid;
    event->timestamp_ns = bpf_ktime_get_ns(); event->cookie = cookie;
    unsigned long value = 0;
    // Deliberately not unrolled. Unrolling replicates the capture switch eight
    // times, and the register pressure that creates makes clang spill a computed
    // ctx pointer, which the verifier rejects with "dereference of modified ctx
    // ptr". The bound is a compile-time constant, so the verifier walks the loop
    // without difficulty on any kernel that supports bounded loops (5.3+).
    for (int index = 0; index < LIVEPROBE_MAX_OPS; index++) {
        if (index >= plan->operation_count) break;
        struct liveprobe_capture_op *op = &plan->operations[index];
        if (op->destination_slot >= LIVEPROBE_MAX_SLOTS) { event->flags |= 1; continue; }
        __u8 destination = op->destination_slot & (LIVEPROBE_MAX_SLOTS - 1);
        if (op->code == LIVEPROBE_READ_REGISTER) value = register_value(ctx, op->reg);
        else if (op->code == LIVEPROBE_READ_FRAME_BASE) { event->flags |= 8; continue; }
        else if (op->code == LIVEPROBE_ADD_CONSTANT) {
            if (!add_user_offset(&value, op->offset)) { event->flags |= 8; continue; }
        }
        else if (op->code == LIVEPROBE_DEREFERENCE_FIXED) {
            // Copy the width out of the map value before validating it. Reading
            // op->width again at the call site lets the compiler reload it from
            // map memory, and the verifier then treats it as an unconstrained
            // __u8 (0-255) regardless of the checks above.
            __u32 width = op->width;
            barrier_var(width);
            if (!valid_user_read(value, width)) { event->flags |= 8; continue; }
            // Read with a compile-time constant size per approved width. A
            // variable size cannot be verified here: the verifier tracks ranges
            // rather than sets, so it learns nothing from the != chain that used
            // to guard this, and clang sinks the reload of op->width past any
            // explicit bound we add. Linux 6.17 rejects the result with
            // "invalid access to memory, mem_size=552 off=488 size=255".
            // Constant sizes make the bound trivial and enforce the approved
            // width set in the same switch.
            // Each arm reads into a differently typed local. Reading straight
            // into event->values[destination] with only the size differing lets
            // clang tail-merge the arms back into one call with a variable size
            // register, which reintroduces the very thing this switch exists to
            // avoid. Distinct destinations keep the arms structurally different.
            // Each scratch local is scoped to its own arm so their live ranges do
            // not overlap. Declaring all five together costs 79 bytes of stack in
            // every one of the eight unrolled iterations, and the resulting
            // register pressure makes clang spill and reload ctx, which the
            // verifier then rejects with "dereference of modified ctx ptr".
            long failed;
            switch (width) {
                case 1: {
                    __u8 read;
                    failed = bpf_probe_read_user(&read, sizeof(read), (void *)value);
                    if (!failed) __builtin_memcpy(event->values[destination], &read, sizeof(read));
                    break;
                }
                case 2: {
                    __u16 read;
                    failed = bpf_probe_read_user(&read, sizeof(read), (void *)value);
                    if (!failed) __builtin_memcpy(event->values[destination], &read, sizeof(read));
                    break;
                }
                case 4: {
                    __u32 read;
                    failed = bpf_probe_read_user(&read, sizeof(read), (void *)value);
                    if (!failed) __builtin_memcpy(event->values[destination], &read, sizeof(read));
                    break;
                }
                case 8: {
                    __u64 read;
                    failed = bpf_probe_read_user(&read, sizeof(read), (void *)value);
                    if (!failed) __builtin_memcpy(event->values[destination], &read, sizeof(read));
                    break;
                }
                case LIVEPROBE_SLOT_BYTES: {
                    __u8 read[LIVEPROBE_SLOT_BYTES];
                    failed = bpf_probe_read_user(read, sizeof(read), (void *)value);
                    if (!failed) __builtin_memcpy(event->values[destination], read, sizeof(read));
                    break;
                }
                default: event->flags |= 2; continue;
            }
            if (failed) { event->flags |= 4; continue; }
            event->widths[destination] = width;
            if (width <= sizeof(value)) __builtin_memcpy(&value, event->values[destination], sizeof(value));
        } else if (op->code == LIVEPROBE_READ_PIECE) {
            event->flags |= 8;
            continue;
        } else if (op->code == LIVEPROBE_STACK_VALUE) {
            __builtin_memcpy(event->values[destination], &value, sizeof(value));
            event->widths[destination] = sizeof(value);
        }
    }
    increment(&capture_counters, cookie);
    bpf_ringbuf_submit(event, 0);
    return 0;
}
