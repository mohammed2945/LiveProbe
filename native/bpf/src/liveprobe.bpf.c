#include <linux/bpf.h>
#include <linux/ptrace.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include "liveprobe.h"

char LICENSE[] SEC("license") = "Dual BSD/GPL";

struct liveprobe_probe_state {
    __u32 generation;
    __u32 disabled;
    __u64 captures;
    __u64 accepted_raw_hits;
};
struct liveprobe_rate_state { __u32 tokens; __u32 reserved; __u64 last_refill_ns; };

struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 4096); __type(key, __u64); __type(value, struct liveprobe_capture_plan); } probe_plans SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 4096); __type(key, __u64); __type(value, struct liveprobe_probe_state); } probe_state SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_PERCPU_HASH); __uint(max_entries, 4096); __type(key, __u64); __type(value, __u64); } raw_hit_counters SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_PERCPU_HASH); __uint(max_entries, 4096); __type(key, __u64); __type(value, __u64); } capture_counters SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_PERCPU_HASH); __uint(max_entries, 4096); __type(key, __u64); __type(value, struct liveprobe_rate_state); } rate_limit_state SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_PERCPU_HASH); __uint(max_entries, 4096); __type(key, __u64); __type(value, __u64); } dropped_event_counters SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_PERCPU_HASH); __uint(max_entries, 4096); __type(key, __u64); __type(value, __u64); } counter_aggregates SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_RINGBUF); __uint(max_entries, 1 << 22); } events SEC(".maps");

static __always_inline void increment(void *map, __u64 cookie) {
    __u64 one = 1, *value = bpf_map_lookup_elem(map, &cookie);
    if (value) __sync_fetch_and_add(value, 1); else bpf_map_update_elem(map, &cookie, &one, BPF_NOEXIST);
}

static __always_inline unsigned long register_value(struct pt_regs *ctx, __u8 reg) {
#if defined(__TARGET_ARCH_x86)
    switch (reg) {
    case 0: return ctx->rax; case 1: return ctx->rdx;
    case 2: return ctx->rcx; case 3: return ctx->rbx;
    case 4: return ctx->rsi; case 5: return ctx->rdi;
    case 6: return ctx->rbp; case 7: return ctx->rsp;
    case 8: return ctx->r8; case 9: return ctx->r9;
    case 10: return ctx->r10; case 11: return ctx->r11;
    case 12: return ctx->r12; case 13: return ctx->r13;
    case 14: return ctx->r14; case 15: return ctx->r15;
    default: return 0;
    }
#else
    return reg < 8 ? ctx->regs[reg] : 0;
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
        struct liveprobe_rate_state initial = { .tokens = plan->burst, .last_refill_ns = bpf_ktime_get_ns() };
        bpf_map_update_elem(&rate_limit_state, &cookie, &initial, BPF_NOEXIST);
        rate = bpf_map_lookup_elem(&rate_limit_state, &cookie);
        if (!rate) return 0;
    }
    __u64 now = bpf_ktime_get_ns();
    int accepted = 0;
    if (!rate->last_refill_ns) { rate->last_refill_ns = now; rate->tokens = plan->burst; }
    __u64 elapsed = now - rate->last_refill_ns;
    if (elapsed >= 1000000000ULL) {
        __u64 added = (elapsed / 1000000000ULL) * plan->refill_per_second;
        __u64 replenished = rate->tokens + added;
        rate->tokens = replenished > plan->burst ? plan->burst : replenished;
        rate->last_refill_ns = now;
    }
    if (rate->tokens) { rate->tokens--; accepted = 1; }
    return accepted;
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
#pragma unroll
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
            if (op->width != 1 && op->width != 2 && op->width != 4 && op->width != 8 && op->width != LIVEPROBE_SLOT_BYTES) { event->flags |= 2; continue; }
            if (!valid_user_read(value, op->width)) { event->flags |= 8; continue; }
            if (bpf_probe_read_user(event->values[destination], op->width, (void *)value)) { event->flags |= 4; continue; }
            event->widths[destination] = op->width;
            if (op->width <= sizeof(value)) __builtin_memcpy(&value, event->values[destination], sizeof(value));
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
