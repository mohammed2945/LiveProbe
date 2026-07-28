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
	test fixtures-test typescript-test python-test python-analysis-test java-test demo-unit-test \
	gcp-deploy-test \
	payment-deps python-demo-deps payment-test inventory-test \
	build typescript-build payment-build java-build inventory-build \
	redaction-audit readonly-audit bench ride-analysis-bench ride-analysis-scale \
	python-probe-bundle-bench ride-analysis-e2e ride-analysis-tracks \
	ride-investigation-e2e ride-runtime-model-track ride-adaptive-comparison \
	ride-four-method-benchmark ride-four-method-benchmark-codex \
	e2e-node e2e-python e2e-jvm \
	demo-prerequisites demo demo-down \
	gcp-demo-prerequisites gcp-demo-up gcp-demo-status gcp-demo-logs gcp-demo-down \
	gcp-monitoring

test: fixtures-test typescript-test python-test java-test demo-unit-test

fixtures-test:
	node scripts/validate-fixtures.mjs

typescript-test:
	pnpm run typecheck
	pnpm run test:packages

python-test:
	cd python/sdk && sh ../../scripts/python312.sh -m pytest

python-analysis-test:
	cd python/analyzer && sh ../../scripts/python312.sh -m pytest

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

bench:
	pnpm --filter @doomslayer2945/liveprobe-node run bench
	sh scripts/python312.sh python/sdk/benchmarks/monitoring_overhead.py

python-probe-bundle-bench:
	PYTHONPATH=python/sdk/src sh scripts/python312.sh \
		python/sdk/benchmarks/probe_bundle_overhead.py \
		--assert-max-p99-ms 5

ride-analysis-bench:
	PYTHONPATH=python/analyzer/src sh scripts/python312.sh \
		python/analyzer/benchmarks/ride_sharing.py \
		--repository ../ride_sharing_probe_demo

ride-analysis-e2e:
	npm --prefix packages/mcp-server run build
	npm --prefix packages/broker run build
	node demo/ride-analysis/e2e.mjs

ride-investigation-e2e:
	npm --prefix packages/mcp-server run build
	npm --prefix packages/broker run build
	node demo/ride-analysis/e2e-investigation.mjs

ride-four-method-benchmark:
	npm --prefix packages/mcp-server run build
	npm --prefix packages/broker run build
	node demo/ride-analysis/four-method-benchmark.mjs \
		--decision-mode=oracle \
		--repetitions=1

ride-four-method-benchmark-codex:
	npm --prefix packages/mcp-server run build
	npm --prefix packages/broker run build
	node demo/ride-analysis/four-method-benchmark.mjs \
		--decision-mode=codex \
		--repetitions=3

ride-analysis-scale:
	PYTHONPATH=python/analyzer/src sh scripts/python312.sh \
		python/analyzer/benchmarks/scale_corpus.py \
		--functions 1000 5000 10000

ride-analysis-tracks:
	PYTHONPATH=python/analyzer/src sh scripts/python312.sh \
		python/analyzer/experiments/ride_sharing_tracks.py \
		--repository ../ride_sharing_probe_demo

ride-runtime-model-track:
	@echo "Historical schema-14 experiment; the supported runtime workflow is: make ride-investigation-e2e"
	PYTHONPATH=python/analyzer/src sh scripts/python312.sh \
		python/analyzer/experiments/runtime_guided_model.py \
		--repository ../ride_sharing_probe_demo

ride-adaptive-comparison:
	@echo "Historical matched passing/failing comparison; the supported runtime workflow is: make ride-investigation-e2e"
	npm --prefix packages/mcp-server run build
	npm --prefix packages/broker run build
	node demo/ride-analysis/adaptive-comparison.mjs --decision-mode=oracle

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
	node scripts/e2e-jvm.mjs

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
