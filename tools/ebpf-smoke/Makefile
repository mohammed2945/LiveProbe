SHELL := /bin/bash

CLANG ?= clang
CC ?= cc
LLVM_OBJDUMP ?= llvm-objdump
READELF ?= readelf
PKG_CONFIG ?= pkg-config

BUILD_DIR := .build
BPF_OBJECT := $(BUILD_DIR)/smoke.bpf.o
LOADER := $(BUILD_DIR)/smoke
TARGET := $(BUILD_DIR)/target
ARCH_INCLUDE := /usr/include/$(shell $(CC) -dumpmachine)

# Keep these flags explicit: the BPF object is optimized but retains BTF/DWARF,
# and __TARGET_ARCH_x86 selects the correct uprobe argument registers.
BPF_CFLAGS := -target bpf -D__TARGET_ARCH_x86 -D__BPF__ \
	-O2 -g -Wall -Wextra -Werror \
	-I$(ARCH_INCLUDE) -I.

# The target deliberately retains frame/debug information and a stable,
# externally visible noinline function. Disable PIE to make symbol inspection
# straightforward; libbpf still resolves the symbol name rather than hardcoding
# an offset.
TARGET_CFLAGS := -O2 -g -Wall -Wextra -Werror \
	-fno-omit-frame-pointer -fno-inline -fno-pie
TARGET_LDFLAGS := -no-pie -Wl,--build-id=sha1

USER_CFLAGS := -O2 -g -Wall -Wextra -Werror \
	$(shell $(PKG_CONFIG) --cflags libbpf)
USER_LDLIBS := $(shell $(PKG_CONFIG) --libs libbpf)

.PHONY: all run readonly-check clean

all: $(BPF_OBJECT) $(TARGET) $(LOADER)

$(BUILD_DIR):
	mkdir -p $@

$(BPF_OBJECT): smoke.bpf.c smoke.h | $(BUILD_DIR)
	$(CLANG) $(BPF_CFLAGS) -c $< -o $@

$(TARGET): target.c smoke.h | $(BUILD_DIR)
	$(CC) $(TARGET_CFLAGS) $< $(TARGET_LDFLAGS) -o $@
	@$(READELF) --notes $@ | grep -q 'Build ID:'

$(LOADER): smoke.c smoke.h | $(BUILD_DIR)
	$(CC) $(USER_CFLAGS) $< $(USER_LDLIBS) -o $@

run: all
	./run.sh

readonly-check: $(BPF_OBJECT)
	@disassembly="$$(mktemp)"; \
	trap 'rm -f "$$disassembly"' EXIT; \
	$(LLVM_OBJDUMP) -dr $(BPF_OBJECT) >"$$disassembly"; \
	if grep -q 'bpf_probe_write_user' "$$disassembly" || \
	   grep -Eq 'call[[:space:]]+0x24([[:space:]]|$$)' "$$disassembly"; then \
		echo 'error: BPF object references bpf_probe_write_user' >&2; \
		exit 1; \
	fi
	@echo 'READONLY_CHECK_OK: no bpf_probe_write_user symbol or helper call 36'

clean:
	rm -rf $(BUILD_DIR)
