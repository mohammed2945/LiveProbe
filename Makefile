SHELL := /bin/sh

DOCKER_COMPOSE ?= docker compose
GCP_DATABASE_BACKEND ?= local
GCP_ENV_FILE ?=
GCP_COMPOSE = $(DOCKER_COMPOSE)
ifneq ($(strip $(GCP_ENV_FILE)),)
GCP_COMPOSE += --env-file $(GCP_ENV_FILE)
endif
GCP_COMPOSE += -f demo/docker-compose.yml -f deploy/gcp/docker-compose.gcp.yml
ifeq ($(GCP_DATABASE_BACKEND),cloud-sql)
GCP_COMPOSE += -f deploy/gcp/docker-compose.cloud-sql.yml
endif
GCP_LOGS_ARGS ?= --tail=200

.PHONY: \
	test fixtures-test typescript-test python-test java-test demo-unit-test \
	gcp-deploy-test \
	payment-deps python-demo-deps payment-test inventory-test \
	build typescript-build payment-build java-build inventory-build \
	redaction-audit readonly-audit bench \
	native-smoke native-build native-test native-ebpf-test native-demo \
	native-release native-install native-loader-relocation-test \
	native-e2e-rust native-e2e-cpp native-e2e native-hot-burst-test \
	e2e-node e2e-python e2e-jvm \
	demo-prerequisites demo demo-down \
	gcp-demo-prerequisites gcp-demo-up gcp-demo-status gcp-demo-logs gcp-demo-down \
	gcp-monitoring gcp-recovery-drill

test: fixtures-test typescript-test python-test java-test demo-unit-test

fixtures-test:
	node scripts/validate-fixtures.mjs

typescript-test:
	pnpm run typecheck
	pnpm run test:packages

python-test:
	cd python/sdk && sh ../../scripts/python312.sh -m pytest

java-test:
	sh scripts/java17.sh $(MAKE) -C java/bridge test

payment-deps:
	@if [ ! -d demo/payment-service/node_modules ]; then \
		echo "Installing payment demo dependencies"; \
		npm --prefix demo/payment-service ci; \
	fi

python-demo-deps:
	@if ! sh scripts/python312.sh -c 'import fastapi, liveprobe, uvicorn' >/dev/null 2>&1; then \
		echo "Installing billing demo dependencies"; \
		sh scripts/python312.sh -m pip install \
			-e "python/sdk" \
			-r demo/billing-worker/requirements.txt; \
	fi

payment-test: payment-deps
	pnpm --filter @doomslayer2945/liveprobe-node run build
	npm --prefix demo/payment-service test

inventory-test:
	@command -v mvn >/dev/null 2>&1 || { echo "Maven 3.9+ is required"; exit 127; }
	sh scripts/java17.sh $(MAKE) -C demo/inventory-service test

demo-unit-test: payment-test inventory-test

gcp-deploy-test:
	deploy/gcp/test.sh

gcp-monitoring:
	deploy/gcp/provision-monitoring.sh

gcp-recovery-drill:
	deploy/gcp/recovery-drill.sh

typescript-build:
	pnpm run build

payment-build: payment-deps
	pnpm --filter @doomslayer2945/liveprobe-node run build
	npm --prefix demo/payment-service run build

java-build:
	sh scripts/java17.sh $(MAKE) -C java/bridge jar

inventory-build:
	sh scripts/java17.sh $(MAKE) -C demo/inventory-service package

build: typescript-build payment-build java-build inventory-build

redaction-audit:
	sh scripts/redaction-audit.sh

readonly-audit:
	node scripts/readonly-audit.mjs

native-smoke:
	$(MAKE) -C tools/ebpf-smoke run

native-build:
	@test "$$(uname -s)" = Linux || { echo "native-build requires Linux"; exit 1; }
	$(MAKE) -C native/bpf
	cargo build --manifest-path native/Cargo.toml --workspace

native-test:
	cargo fmt --manifest-path native/Cargo.toml --check
	cargo test --manifest-path native/Cargo.toml --workspace

native-ebpf-test:
	@test "$$(uname -s)" = Linux || { echo "native-ebpf-test requires Linux"; exit 1; }
	@test "$$(uname -m)" = x86_64 || { echo "native-ebpf-test requires x86_64"; exit 1; }
	$(MAKE) native-build
	$(MAKE) -C native/bpf audit
	$(MAKE) -C native/tests all
	sudo -n native/tests/.build/ebpf-integration \
		native/bpf/liveprobe.bpf.o native/tests/.build/target

native-demo:
	cargo build --manifest-path demo/rust-service/Cargo.toml --release
	$(MAKE) -C demo/cpp-service

NATIVE_PREFIX ?= /usr/local
DESTDIR ?=

native-release:
	@test "$$(uname -s)" = Linux || { echo "native-release requires Linux"; exit 1; }
	$(MAKE) -C native/bpf audit
	cargo build --manifest-path native/Cargo.toml --workspace --release

native-loader-relocation-test: native-release
	@tmp="$$(mktemp -d)"; \
	trap 'rm -rf "$$tmp"' EXIT INT TERM; \
	cp native/target/release/liveprobe-bpf-loader "$$tmp/"; \
	cd / && "$$tmp/liveprobe-bpf-loader" --verify-embedded

native-install: native-release
	install -d "$(DESTDIR)$(NATIVE_PREFIX)/bin" "$(DESTDIR)/etc/liveprobe" \
		"$(DESTDIR)/run/liveprobe"
	install -m 0755 native/target/release/liveprobe-native-agent \
		"$(DESTDIR)$(NATIVE_PREFIX)/bin/liveprobe-native-agent"
	install -m 0755 native/target/release/liveprobe-bpf-loader \
		"$(DESTDIR)$(NATIVE_PREFIX)/bin/liveprobe-bpf-loader"

native-e2e-rust: native-release native-demo
	pnpm --filter @liveprobe/protocol build
	pnpm --filter @liveprobe/broker build
	node scripts/native-e2e.mjs rust

native-e2e-cpp: native-release native-demo
	pnpm --filter @liveprobe/protocol build
	pnpm --filter @liveprobe/broker build
	node scripts/native-e2e.mjs cpp

native-e2e: native-e2e-rust native-e2e-cpp

native-hot-burst-test: native-e2e-rust

bench:
	pnpm --filter @doomslayer2945/liveprobe-node run bench
	sh scripts/python312.sh python/sdk/benchmarks/monitoring_overhead.py

e2e-node: payment-deps
	pnpm --filter @doomslayer2945/liveprobe-node run build
	pnpm --filter @liveprobe/broker run build
	npm --prefix demo/payment-service run e2e

e2e-python: python-demo-deps
	pnpm --filter @liveprobe/broker run build
	sh scripts/python312.sh demo/billing-worker/e2e.py

e2e-jvm:
	pnpm --filter @liveprobe/broker run build
	sh scripts/java17.sh $(MAKE) -C java/bridge jar
	sh scripts/java17.sh $(MAKE) -C demo/inventory-service package
	sh scripts/java17.sh node scripts/e2e-jvm.mjs

demo-prerequisites:
	pnpm --filter @doomslayer2945/liveprobe-node run build
	$(DOCKER_COMPOSE) -f demo/docker-compose.yml config --quiet

demo: demo-prerequisites
	$(DOCKER_COMPOSE) -f demo/docker-compose.yml --profile mcp build
	$(DOCKER_COMPOSE) -f demo/docker-compose.yml up --detach --wait
	node scripts/print-demo-config.mjs

demo-down:
	$(DOCKER_COMPOSE) -f demo/docker-compose.yml down --remove-orphans

gcp-demo-prerequisites:
	pnpm --filter @doomslayer2945/liveprobe-node run build
	$(GCP_COMPOSE) config --quiet

gcp-demo-up: gcp-demo-prerequisites
	$(GCP_COMPOSE) build
	$(GCP_COMPOSE) up --detach --wait --remove-orphans

gcp-demo-status:
	$(GCP_COMPOSE) ps

gcp-demo-logs:
	$(GCP_COMPOSE) logs $(GCP_LOGS_ARGS)

gcp-demo-down:
	$(GCP_COMPOSE) down --remove-orphans
