#ifndef LIVEPROBE_NATIVE_ABI_H
#define LIVEPROBE_NATIVE_ABI_H

#include <linux/types.h>

#define LIVEPROBE_ABI_VERSION 2
#define LIVEPROBE_MAX_OPS 8
#define LIVEPROBE_MAX_SLOTS 8
#define LIVEPROBE_SLOT_BYTES 64

enum liveprobe_opcode {
    LIVEPROBE_READ_REGISTER = 1,
    LIVEPROBE_READ_FRAME_BASE = 2,
    LIVEPROBE_ADD_CONSTANT = 3,
    LIVEPROBE_DEREFERENCE_FIXED = 4,
    LIVEPROBE_STACK_VALUE = 5,
    LIVEPROBE_READ_PIECE = 6,
};

struct liveprobe_capture_op {
    __u8 code;
    __u8 reg;
    __u8 width;
    __u8 destination_slot;
    __s32 offset;
    __u32 reserved;
};

struct liveprobe_capture_plan {
    __u16 abi_version;
    __u8 operation_count;
    __u8 slot_count;
    __u32 generation;
    __u32 pid;
    __u32 program_kind;
    __u64 cgroup_id;
    __u64 hit_limit;
    __u32 refill_per_second;
    __u32 burst;
    __u32 sample_every;
    __u32 reserved;
    struct liveprobe_capture_op operations[LIVEPROBE_MAX_OPS];
};

struct liveprobe_raw_event {
    __u16 abi_version;
    __u8 slot_count;
    __u8 flags;
    __u32 generation;
    __u32 pid;
    __u32 tid;
    __u64 timestamp_ns;
    __u64 cookie;
    __u8 widths[LIVEPROBE_MAX_SLOTS];
    __u8 values[LIVEPROBE_MAX_SLOTS][LIVEPROBE_SLOT_BYTES];
};

#endif
