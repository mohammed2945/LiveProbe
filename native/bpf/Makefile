CLANG ?= clang
ARCH ?= x86
MULTIARCH ?= /usr/include/x86_64-linux-gnu
CFLAGS := -O2 -g -target bpf -D__TARGET_ARCH_$(ARCH) -Wall -Werror \
	-Iinclude -I$(MULTIARCH)

.PHONY: all clean audit
all: liveprobe.bpf.o

liveprobe.bpf.o: src/liveprobe.bpf.c include/liveprobe.h
	$(CLANG) $(CFLAGS) -c $< -o $@

audit: liveprobe.bpf.o
	@if grep -R "bpf_probe_write_user" src include; then exit 1; fi
	@if llvm-objdump -d liveprobe.bpf.o | grep -Eq 'call[[:space:]]+36([[:space:]]|$$)'; then \
		echo "forbidden bpf_probe_write_user helper call" >&2; exit 1; fi
# Every bpf_probe_read_user (helper 112) must take a compile-time constant size.
# A size held in a register comes from a map value the verifier cannot bound, and
# the kernel rejects the program with "invalid access to memory". Source-level
# guards are not enough: clang will tail-merge switch arms that differ only in a
# constant back into one variable-size call, so this checks the emitted object.
	@llvm-objdump -d liveprobe.bpf.o | awk ' \
		/r2 = r[0-9]/ { variable = 1; next } \
		/r2 = -?[0-9]/ { variable = 0; next } \
		/call[[:space:]]+112([[:space:]]|$$)/ { \
			if (variable) { print "variable-size bpf_probe_read_user: " $$0 > "/dev/stderr"; bad = 1 } } \
		END { exit bad }' || { \
		echo "bpf_probe_read_user must use a constant size" >&2; exit 1; }

clean:
	rm -f liveprobe.bpf.o
