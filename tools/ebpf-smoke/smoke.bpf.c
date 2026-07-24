#include "smoke.h"

#include <linux/bpf.h>
#include <linux/ptrace.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

struct {
	__uint(type, BPF_MAP_TYPE_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, __u64);
} smoke_counter SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 256 * 1024);
} smoke_events SEC(".maps");

SEC("uprobe")
int smoke_uprobe(struct pt_regs *ctx)
{
	const __u64 pid_tgid = bpf_get_current_pid_tgid();
	const __s32 value = (__s32)PT_REGS_PARM1(ctx);
	struct smoke_event *event;
	__u32 key = 0;
	__u64 *counter;

	counter = bpf_map_lookup_elem(&smoke_counter, &key);
	if (counter)
		__sync_fetch_and_add(counter, 1);

	event = bpf_ringbuf_reserve(&smoke_events, sizeof(*event), 0);
	if (!event)
		return 0;

	event->pid = pid_tgid >> 32;
	event->tid = (__u32)pid_tgid;
	event->timestamp_ns = bpf_ktime_get_ns();
	event->value = value;
	event->reserved = 0;
	bpf_ringbuf_submit(event, 0);
	return 0;
}

char LICENSE[] SEC("license") = "GPL";
