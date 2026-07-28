CC ?= cc
BUILD := .build
CFLAGS := -O2 -g -Wall -Wextra -Werror
LIBBPF_CFLAGS := $(shell pkg-config --cflags libbpf)
LIBBPF_LIBS := $(shell pkg-config --libs libbpf)

.PHONY: all run clean
all: $(BUILD)/target $(BUILD)/ebpf-integration

$(BUILD):
	mkdir -p $@

$(BUILD)/target: fixtures/target.c | $(BUILD)
	$(CC) $(CFLAGS) -fno-inline -fno-omit-frame-pointer -fno-pie $< -no-pie -Wl,--build-id=sha1 -o $@

$(BUILD)/ebpf-integration: ebpf_integration.c ../bpf/include/liveprobe.h | $(BUILD)
	$(CC) $(CFLAGS) $(LIBBPF_CFLAGS) -I../bpf/include $< $(LIBBPF_LIBS) -o $@

run: all
	@if [ "$$(uname -s)" != Linux ]; then echo "SKIP: native eBPF integration requires Linux"; exit 0; fi
	@if [ "$$(uname -m)" != x86_64 ]; then echo "SKIP: native eBPF integration target is x86_64"; exit 0; fi
	$(BUILD)/ebpf-integration ../bpf/liveprobe.bpf.o $(BUILD)/target

clean:
	rm -rf $(BUILD)
