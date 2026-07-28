#include "smoke.h"

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

__attribute__((noinline, used, visibility("default")))
int smoke_target(int value)
{
	volatile int observed = value;

	return observed + 1;
}

static int parse_int(const char *text, int *value)
{
	char *end = NULL;
	long parsed;

	errno = 0;
	parsed = strtol(text, &end, 10);
	if (errno != 0 || end == text || *end != '\0' || parsed < 0 ||
	    parsed > INT_MAX)
		return -1;
	*value = (int)parsed;
	return 0;
}

int main(int argc, char **argv)
{
	char byte = 'R';
	int value;
	int ready_fd;
	int go_fd;

	if (argc != 4 || parse_int(argv[1], &value) != 0 ||
	    parse_int(argv[2], &ready_fd) != 0 ||
	    parse_int(argv[3], &go_fd) != 0) {
		fprintf(stderr, "usage: %s VALUE READY_FD GO_FD\n", argv[0]);
		return 2;
	}

	if (write(ready_fd, &byte, 1) != 1) {
		perror("write ready");
		return 3;
	}
	close(ready_fd);

	if (read(go_fd, &byte, 1) != 1) {
		perror("read go");
		return 4;
	}
	close(go_fd);

	if (smoke_target(value) != value + 1) {
		fprintf(stderr, "target result mismatch\n");
		return 5;
	}

	printf("TARGET_OK value=%d\n", value);
	return 0;
}
