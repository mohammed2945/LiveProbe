#include "smoke.h"

#include <bpf/bpf.h>
#include <bpf/libbpf.h>
#include <errno.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

struct event_state {
	struct smoke_event event;
	unsigned int seen;
};

static int libbpf_log(enum libbpf_print_level level, const char *format,
		      va_list args)
{
	(void)level;
	return vfprintf(stderr, format, args);
}

static int handle_event(void *context, void *data, size_t size)
{
	struct event_state *state = context;

	if (size != sizeof(state->event)) {
		fprintf(stderr, "unexpected ring-buffer record size: %zu\n", size);
		return -EINVAL;
	}
	memcpy(&state->event, data, sizeof(state->event));
	state->seen++;
	return 0;
}

static int wait_for_ready(int fd)
{
	char byte;

	if (read(fd, &byte, 1) != 1 || byte != 'R') {
		fprintf(stderr, "target failed to reach attach gate\n");
		return -1;
	}
	return 0;
}

int main(int argc, char **argv)
{
	LIBBPF_OPTS(bpf_uprobe_opts, uprobe_opts,
		.func_name = "smoke_target",
		.retprobe = false);
	struct bpf_object *object = NULL;
	struct bpf_program *program;
	struct bpf_link *link = NULL;
	struct ring_buffer *ring = NULL;
	struct event_state state = {};
	__u64 counter = 0;
	__u32 key = 0;
	int ready_pipe[2] = {-1, -1};
	int go_pipe[2] = {-1, -1};
	int events_fd;
	int counter_fd;
	int child_status = 0;
	pid_t child = -1;
	bool child_waited = false;
	int result = 1;
	int error;

	if (argc != 3) {
		fprintf(stderr, "usage: %s BPF_OBJECT TARGET\n", argv[0]);
		return 2;
	}

	libbpf_set_print(libbpf_log);
	object = bpf_object__open_file(argv[1], NULL);
	error = libbpf_get_error(object);
	if (error) {
		object = NULL;
		fprintf(stderr, "OPEN_FAILED: %s\n", strerror(-error));
		goto cleanup;
	}
	if (bpf_object__load(object) != 0) {
		fprintf(stderr, "VERIFIER_LOAD_FAILED (see libbpf log above)\n");
		goto cleanup;
	}
	puts("LOAD_VERIFIER_OK");

	program = bpf_object__find_program_by_name(object, "smoke_uprobe");
	events_fd = bpf_object__find_map_fd_by_name(object, "smoke_events");
	counter_fd = bpf_object__find_map_fd_by_name(object, "smoke_counter");
	if (!program || events_fd < 0 || counter_fd < 0) {
		fprintf(stderr, "required program or map not found\n");
		goto cleanup;
	}

	ring = ring_buffer__new(events_fd, handle_event, &state, NULL);
	error = libbpf_get_error(ring);
	if (error) {
		ring = NULL;
		fprintf(stderr, "ring_buffer__new failed: %s\n", strerror(-error));
		goto cleanup;
	}

	if (pipe(ready_pipe) != 0 || pipe(go_pipe) != 0) {
		perror("pipe");
		goto cleanup;
	}

	child = fork();
	if (child < 0) {
		perror("fork");
		goto cleanup;
	}
	if (child == 0) {
		char ready_fd_text[16];
		char go_fd_text[16];

		close(ready_pipe[0]);
		close(go_pipe[1]);
		snprintf(ready_fd_text, sizeof(ready_fd_text), "%d", ready_pipe[1]);
		snprintf(go_fd_text, sizeof(go_fd_text), "%d", go_pipe[0]);
		execl(argv[2], argv[2], "4242", ready_fd_text, go_fd_text, NULL);
		perror("exec target");
		_exit(127);
	}

	close(ready_pipe[1]);
	ready_pipe[1] = -1;
	close(go_pipe[0]);
	go_pipe[0] = -1;
	if (wait_for_ready(ready_pipe[0]) != 0)
		goto cleanup;
	close(ready_pipe[0]);
	ready_pipe[0] = -1;

	link = bpf_program__attach_uprobe_opts(program, child, argv[2], 0,
					       &uprobe_opts);
	error = libbpf_get_error(link);
	if (error) {
		link = NULL;
		fprintf(stderr, "UPROBE_ATTACH_FAILED: %s\n", strerror(-error));
		goto cleanup;
	}
	printf("UPROBE_ATTACH_OK pid=%d function=smoke_target\n", child);

	if (write(go_pipe[1], "G", 1) != 1) {
		perror("release target");
		goto cleanup;
	}
	close(go_pipe[1]);
	go_pipe[1] = -1;

	for (int attempt = 0; attempt < 20 && state.seen == 0; attempt++) {
		error = ring_buffer__poll(ring, 500);
		if (error < 0 && error != -EINTR) {
			fprintf(stderr, "ring_buffer__poll failed: %s\n", strerror(-error));
			goto cleanup;
		}
	}

	if (waitpid(child, &child_status, 0) != child) {
		perror("waitpid");
		goto cleanup;
	}
	child_waited = true;
	if (!WIFEXITED(child_status) || WEXITSTATUS(child_status) != 0) {
		fprintf(stderr, "target exited unsuccessfully: status=%d\n", child_status);
		goto cleanup;
	}

	if (state.seen != 1 || state.event.pid != (__u32)child ||
	    state.event.tid != (__u32)child ||
	    state.event.timestamp_ns == 0 ||
	    state.event.value != SMOKE_EXPECTED_VALUE) {
		fprintf(stderr,
			"event mismatch: seen=%u pid=%u tid=%u timestamp=%llu value=%d\n",
			state.seen, state.event.pid, state.event.tid,
			(unsigned long long)state.event.timestamp_ns,
			state.event.value);
		goto cleanup;
	}
	printf("RING_BUFFER_OK pid=%u tid=%u timestamp_ns=%llu value=%d\n",
	       state.event.pid, state.event.tid,
	       (unsigned long long)state.event.timestamp_ns, state.event.value);

	if (bpf_map_lookup_elem(counter_fd, &key, &counter) != 0) {
		perror("bpf_map_lookup_elem");
		goto cleanup;
	}
	if (counter != 1) {
		fprintf(stderr, "counter mismatch: expected=1 actual=%llu\n",
			(unsigned long long)counter);
		goto cleanup;
	}
	printf("COUNTER_OK value=%llu\n", (unsigned long long)counter);
	result = 0;

cleanup:
	if (go_pipe[1] >= 0)
		close(go_pipe[1]);
	if (go_pipe[0] >= 0)
		close(go_pipe[0]);
	if (ready_pipe[1] >= 0)
		close(ready_pipe[1]);
	if (ready_pipe[0] >= 0)
		close(ready_pipe[0]);
	if (child > 0 && !child_waited)
		waitpid(child, &child_status, 0);
	bpf_link__destroy(link);
	ring_buffer__free(ring);
	bpf_object__close(object);
	puts("CLEANUP_OK: link destroyed and map/program FDs closed");
	if (result == 0)
		puts("EBPF_SMOKE_OK");
	return result;
}
