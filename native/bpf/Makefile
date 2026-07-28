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

clean:
	rm -f liveprobe.bpf.o
