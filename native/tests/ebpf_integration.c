#include "liveprobe.h"
#include <bpf/bpf.h>
#include <bpf/libbpf.h>
#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

struct probe_state_value {
    __u32 generation;
    __u32 disabled;
    __u64 captures;
    __u64 accepted_raw_hits;
};
enum {
    COUNT_COOKIE = 1001, SNAPSHOT_COOKIE = 1002, ZERO_COOKIE = 1003, FBREG_COOKIE = 1004,
    SAMPLE_ONE_COOKIE = 1011, SAMPLE_TWO_COOKIE = 1012, SAMPLE_TEN_COOKIE = 1013,
    SAMPLE_TOKEN_COOKIE = 1014
};
struct observed {
    struct liveprobe_raw_event snapshot;
    struct liveprobe_raw_event zero;
    struct liveprobe_raw_event fbreg;
    int seen_snapshot;
    int seen_zero;
    int seen_fbreg;
    int sample_one;
    int sample_two;
    int sample_ten;
    int sample_token;
};

static int on_event(void *context, void *data, size_t size) {
    struct observed *observed = context;
    if (size != sizeof(observed->snapshot)) return -EINVAL;
    struct liveprobe_raw_event *event = data;
    if (event->cookie == SNAPSHOT_COOKIE) {
        memcpy(&observed->snapshot, data, size); observed->seen_snapshot++;
    } else if (event->cookie == ZERO_COOKIE) {
        memcpy(&observed->zero, data, size); observed->seen_zero++;
    } else if (event->cookie == FBREG_COOKIE) {
        memcpy(&observed->fbreg, data, size); observed->seen_fbreg++;
    } else if (event->cookie == SAMPLE_ONE_COOKIE) observed->sample_one++;
    else if (event->cookie == SAMPLE_TWO_COOKIE) observed->sample_two++;
    else if (event->cookie == SAMPLE_TEN_COOKIE) observed->sample_ten++;
    else if (event->cookie == SAMPLE_TOKEN_COOKIE) observed->sample_token++;
    return 0;
}

static int update_sampling(struct bpf_object *object, __u64 cookie, __u32 pid,
                           __u32 generation, __u32 every, __u32 burst) {
    struct liveprobe_capture_plan plan = {
        .abi_version = LIVEPROBE_ABI_VERSION, .generation = generation, .pid = pid,
        .hit_limit = 5000, .refill_per_second = 1, .burst = burst, .sample_every = every
    };
    struct probe_state_value state = { .generation = generation };
    return bpf_map_update_elem(bpf_object__find_map_fd_by_name(object, "probe_plans"), &cookie, &plan, BPF_ANY) ||
        bpf_map_update_elem(bpf_object__find_map_fd_by_name(object, "probe_state"), &cookie, &state, BPF_ANY);
}

static int update_configuration(struct bpf_object *object, __u64 cookie, __u32 pid, int mode) {
    struct liveprobe_capture_plan plan = { .abi_version = LIVEPROBE_ABI_VERSION, .generation = 7, .pid = pid, .hit_limit = 5000, .refill_per_second = 1, .burst = 1, .sample_every = 1 };
    struct probe_state_value state = { .generation = 7 };
    if (mode == 1) {
        plan.hit_limit = 10; plan.refill_per_second = 100; plan.burst = 100;
        plan.operation_count = 2; plan.slot_count = 1;
        plan.operations[0] = (struct liveprobe_capture_op){ .code = LIVEPROBE_READ_REGISTER, .reg = 5, .width = 8, .destination_slot = 0 };
        plan.operations[1] = (struct liveprobe_capture_op){ .code = LIVEPROBE_STACK_VALUE, .width = 8, .destination_slot = 0 };
    } else if (mode == 2) {
        plan.hit_limit = 10; plan.refill_per_second = 100; plan.burst = 100;
        plan.operation_count = 4; plan.slot_count = 1;
        plan.operations[0] = (struct liveprobe_capture_op){ .code = LIVEPROBE_READ_REGISTER, .reg = 6, .width = 8, .destination_slot = 0 };
        plan.operations[1] = (struct liveprobe_capture_op){ .code = LIVEPROBE_ADD_CONSTANT, .offset = 16, .width = 8, .destination_slot = 0 };
        plan.operations[2] = (struct liveprobe_capture_op){ .code = LIVEPROBE_ADD_CONSTANT, .offset = -40, .width = 8, .destination_slot = 0 };
        plan.operations[3] = (struct liveprobe_capture_op){ .code = LIVEPROBE_DEREFERENCE_FIXED, .width = 8, .destination_slot = 0 };
    }
    return bpf_map_update_elem(bpf_object__find_map_fd_by_name(object, "probe_plans"), &cookie, &plan, BPF_ANY) ||
        bpf_map_update_elem(bpf_object__find_map_fd_by_name(object, "probe_state"), &cookie, &state, BPF_ANY);
}

static unsigned long long per_cpu_sum(int fd, __u64 cookie) {
    int cpus = libbpf_num_possible_cpus(); __u64 *values = calloc((size_t)cpus, sizeof(*values)); unsigned long long sum = 0;
    if (!values || bpf_map_lookup_elem(fd, &cookie, values)) { free(values); return 0; }
    for (int cpu = 0; cpu < cpus; cpu++)
        sum += values[cpu];
    free(values);
    return sum;
}

int main(int argc, char **argv) {
    if (argc != 3) { fprintf(stderr, "usage: %s BPF_OBJECT TARGET\n", argv[0]); return 2; }
    struct bpf_object *object = bpf_object__open_file(argv[1], NULL); if (libbpf_get_error(object) || bpf_object__load(object)) { fprintf(stderr, "VERIFIER_LOAD_FAILED\n"); return 1; }
    puts("LOAD_VERIFIER_OK");
    int ready[2], go[2], done[2]; if (pipe(ready) || pipe(go) || pipe(done)) return 1; pid_t child = fork();
    if (!child) { char a[16], b[16], c[16]; close(ready[0]); close(go[1]); close(done[0]); snprintf(a,sizeof(a),"%d",ready[1]); snprintf(b,sizeof(b),"%d",go[0]); snprintf(c,sizeof(c),"%d",done[1]); execl(argv[2],argv[2],"4242",a,b,c,NULL); _exit(127); }
    close(ready[1]); close(go[0]); close(done[1]); char marker; if (read(ready[0], &marker, 1) != 1) return 1;
    const __u64 count_cookie = COUNT_COOKIE, snapshot_cookie = SNAPSHOT_COOKIE, zero_cookie = ZERO_COOKIE, fbreg_cookie = FBREG_COOKIE;
    if (update_configuration(object, count_cookie, child, 0) ||
        update_configuration(object, snapshot_cookie, child, 1) ||
        update_configuration(object, zero_cookie, child, 0) ||
        update_configuration(object, fbreg_cookie, child, 2) ||
        update_sampling(object, SAMPLE_ONE_COOKIE, child, 7, 1, 5000) ||
        update_sampling(object, SAMPLE_TWO_COOKIE, child, 7, 2, 5000) ||
        update_sampling(object, SAMPLE_TEN_COOKIE, child, 7, 10, 5000) ||
        update_sampling(object, SAMPLE_TOKEN_COOKIE, child, 7, 2, 7)) return 1;
    struct bpf_program *count_program = bpf_object__find_program_by_name(object, "liveprobe_count");
    struct bpf_program *snapshot_program = bpf_object__find_program_by_name(object, "liveprobe_snapshot");
    LIBBPF_OPTS(bpf_uprobe_opts, count_opts, .func_name = "native_test_target", .bpf_cookie = count_cookie);
    LIBBPF_OPTS(bpf_uprobe_opts, snapshot_opts, .func_name = "native_test_target", .bpf_cookie = snapshot_cookie);
    LIBBPF_OPTS(bpf_uprobe_opts, zero_opts, .func_name = "native_test_target", .bpf_cookie = zero_cookie);
    count_opts.func_name = "native_count_target";
    LIBBPF_OPTS(bpf_uprobe_opts, fbreg_opts, .func_name = "native_fbreg_target", .bpf_cookie = fbreg_cookie);
    LIBBPF_OPTS(bpf_uprobe_opts, sample_one_opts, .func_name = "native_count_target", .bpf_cookie = SAMPLE_ONE_COOKIE);
    LIBBPF_OPTS(bpf_uprobe_opts, sample_two_opts, .func_name = "native_count_target", .bpf_cookie = SAMPLE_TWO_COOKIE);
    LIBBPF_OPTS(bpf_uprobe_opts, sample_ten_opts, .func_name = "native_count_target", .bpf_cookie = SAMPLE_TEN_COOKIE);
    LIBBPF_OPTS(bpf_uprobe_opts, sample_token_opts, .func_name = "native_count_target", .bpf_cookie = SAMPLE_TOKEN_COOKIE);
    struct bpf_link *count_link = bpf_program__attach_uprobe_opts(count_program, child, argv[2], 0, &count_opts);
    struct bpf_link *snapshot_link = bpf_program__attach_uprobe_opts(snapshot_program, child, argv[2], 0, &snapshot_opts);
    struct bpf_link *zero_link = bpf_program__attach_uprobe_opts(snapshot_program, child, argv[2], 0, &zero_opts);
    struct bpf_link *fbreg_link = bpf_program__attach_uprobe_opts(snapshot_program, child, argv[2], 0x31, &fbreg_opts);
    struct bpf_link *sample_one_link = bpf_program__attach_uprobe_opts(snapshot_program, child, argv[2], 0, &sample_one_opts);
    struct bpf_link *sample_two_link = bpf_program__attach_uprobe_opts(snapshot_program, child, argv[2], 0, &sample_two_opts);
    struct bpf_link *sample_ten_link = bpf_program__attach_uprobe_opts(snapshot_program, child, argv[2], 0, &sample_ten_opts);
    struct bpf_link *sample_token_link = bpf_program__attach_uprobe_opts(snapshot_program, child, argv[2], 0, &sample_token_opts);
    if (libbpf_get_error(count_link) || libbpf_get_error(snapshot_link) || libbpf_get_error(zero_link) || libbpf_get_error(fbreg_link) ||
        libbpf_get_error(sample_one_link) || libbpf_get_error(sample_two_link) || libbpf_get_error(sample_ten_link) || libbpf_get_error(sample_token_link)) {
        fprintf(stderr,"UPROBE_ATTACH_FAILED\n"); return 1;
    }
    puts("UPROBE_ATTACH_OK");
    struct observed observed = {}; struct ring_buffer *ring = ring_buffer__new(bpf_object__find_map_fd_by_name(object,"events"), on_event, &observed, NULL);
    if (write(go[1], "G", 1) != 1)
        return 1;
    if (read(done[0], &marker, 1) != 1) return 1;
    for (int attempt=0; attempt<20 && (!observed.seen_snapshot || !observed.seen_zero || !observed.seen_fbreg || observed.sample_one < 1000); attempt++)
        if (ring_buffer__poll(ring, 250) < 0) return 1;
    unsigned long long count = per_cpu_sum(bpf_object__find_map_fd_by_name(object,"counter_aggregates"), count_cookie);
    if (count != 1000) { fprintf(stderr,"exact counter mismatch count=%llu\n", count); return 1; }
    printf("COUNTER_EXACT_OK value=%llu\n", count);
    int raw_fd = bpf_object__find_map_fd_by_name(object,"raw_hit_counters");
    int capture_fd = bpf_object__find_map_fd_by_name(object,"capture_counters");
    unsigned long long raw_one = per_cpu_sum(raw_fd, SAMPLE_ONE_COOKIE);
    unsigned long long raw_two = per_cpu_sum(raw_fd, SAMPLE_TWO_COOKIE);
    unsigned long long raw_ten = per_cpu_sum(raw_fd, SAMPLE_TEN_COOKIE);
    unsigned long long raw_token = per_cpu_sum(raw_fd, SAMPLE_TOKEN_COOKIE);
    unsigned long long capture_one = per_cpu_sum(capture_fd, SAMPLE_ONE_COOKIE);
    unsigned long long capture_two = per_cpu_sum(capture_fd, SAMPLE_TWO_COOKIE);
    unsigned long long capture_ten = per_cpu_sum(capture_fd, SAMPLE_TEN_COOKIE);
    unsigned long long capture_token = per_cpu_sum(capture_fd, SAMPLE_TOKEN_COOKIE);
    if (raw_one != 1000 || raw_two != 1000 || raw_ten != 1000 || raw_token != 1000 ||
        capture_one != 1000 || capture_two != 500 || capture_ten != 100 || capture_token != 7) {
        fprintf(stderr,
            "sampling or raw-counter mismatch raw=%llu/%llu/%llu/%llu capture=%llu/%llu/%llu/%llu\n",
            raw_one, raw_two, raw_ten, raw_token,
            capture_one, capture_two, capture_ten, capture_token);
        return 1;
    }
    if (observed.sample_one != 1000 || observed.sample_two != 500 || observed.sample_ten != 100 || observed.sample_token != 7) {
        fprintf(stderr,"sampling event mismatch n1=%d n2=%d n10=%d token=%d\n", observed.sample_one, observed.sample_two, observed.sample_ten, observed.sample_token); return 1;
    }
    puts("SAMPLING_N1_N2_N10_TOKEN_OK");
    if (update_sampling(object, SAMPLE_TEN_COOKIE, child, 8, 5, 5000)) return 1;
    bpf_link__destroy(count_link); count_link = NULL;
    puts("MANUAL_COUNT_LINK_DETACH_OK");
    if (write(go[1], "G", 1) != 1) return 1;
    close(go[1]); close(done[0]);
    int status;
    waitpid(child, &status, 0);
    for (int attempt=0; attempt<20 && observed.sample_ten < 300; attempt++)
        if (ring_buffer__poll(ring, 250) < 0) return 1;
    __u64 captured = 0; memcpy(&captured, observed.snapshot.values[0], sizeof(captured));
    __u64 fbreg_captured = 0; memcpy(&fbreg_captured, observed.fbreg.values[0], sizeof(fbreg_captured));
    unsigned long long count_after_detach = per_cpu_sum(bpf_object__find_map_fd_by_name(object,"counter_aggregates"), count_cookie);
    if (!WIFEXITED(status) || WEXITSTATUS(status) || observed.seen_snapshot != 1 ||
        observed.seen_zero != 1 || observed.seen_fbreg != 1 || observed.snapshot.pid != (__u32)child ||
        observed.zero.pid != (__u32)child || observed.zero.slot_count != 0 ||
        captured != 4242 || fbreg_captured != 4242 || count_after_detach != 1000 ||
        per_cpu_sum(raw_fd, SAMPLE_TEN_COOKIE) != 2000 ||
        per_cpu_sum(capture_fd, SAMPLE_TEN_COOKIE) != 300 || observed.sample_ten != 300) {
        fprintf(stderr,"event mismatch snapshot=%d zero=%d fbreg=%d value=%llu fbreg_value=%llu count=%llu\n",
            observed.seen_snapshot,observed.seen_zero,observed.seen_fbreg,(unsigned long long)captured,
            (unsigned long long)fbreg_captured,count_after_detach); return 1;
    }
    printf("RING_BUFFER_OK value=%llu pid=%u tid=%u\n",(unsigned long long)captured,observed.snapshot.pid,observed.snapshot.tid);
    printf("FBREG_CAPTURE_OK value=%llu\n",(unsigned long long)fbreg_captured);
    printf("COUNTER_OK value=%llu\n",count_after_detach);
    puts("ZERO_OPERATION_OK");
    puts("SAMPLING_PLAN_UPDATE_OK");
    bpf_link__destroy(sample_token_link); bpf_link__destroy(sample_ten_link); bpf_link__destroy(sample_two_link); bpf_link__destroy(sample_one_link);
    bpf_link__destroy(fbreg_link); bpf_link__destroy(zero_link); bpf_link__destroy(snapshot_link); ring_buffer__free(ring); bpf_object__close(object);
    puts("CLEANUP_OK"); return 0;
}
