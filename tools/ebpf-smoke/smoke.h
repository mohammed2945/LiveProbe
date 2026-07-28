#ifndef LIGHTPROBE_EBPF_SMOKE_H
#define LIGHTPROBE_EBPF_SMOKE_H

#define SMOKE_EXPECTED_VALUE 4242

#ifdef __BPF__
#include <linux/types.h>
typedef __u32 smoke_u32;
typedef __s32 smoke_s32;
typedef __u64 smoke_u64;
#else
#include <stdint.h>
typedef uint32_t smoke_u32;
typedef int32_t smoke_s32;
typedef uint64_t smoke_u64;
#endif

struct smoke_event {
	smoke_u32 pid;
	smoke_u32 tid;
	smoke_u64 timestamp_ns;
	smoke_s32 value;
	smoke_u32 reserved;
};

#endif
