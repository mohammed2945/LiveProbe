SHELL := /bin/sh

JAVAC ?= javac
JAVA ?= java
JAR ?= jar

BUILD_DIR := build
MAIN_CLASSES := $(BUILD_DIR)/classes/main
TEST_CLASSES := $(BUILD_DIR)/classes/test
JAR_FILE := $(BUILD_DIR)/liveprobe-bridge.jar
MAIN_CLASS := io.liveprobe.bridge.Main
TEST_CLASS := io.liveprobe.bridge.BridgeTests
MAIN_SOURCES := $(wildcard src/main/java/io/liveprobe/bridge/*.java)
TEST_SOURCES := $(wildcard src/test/java/io/liveprobe/bridge/*.java)
JDI_MODULE := --add-modules jdk.jdi

.PHONY: all check-jdk classes jar test clean

all: jar

check-jdk:
	@command -v "$(JAVAC)" >/dev/null 2>&1 || { echo "javac is required"; exit 1; }
	@major=$$("$(JAVAC)" -version 2>&1 | awk '{ split($$2, v, "."); if (v[1] == "1") print v[2]; else print v[1] }'); \
		[ "$$major" -ge 17 ] || { echo "JDK 17+ is required (found javac $$major)"; exit 1; }

classes: check-jdk
	@mkdir -p "$(MAIN_CLASSES)"
	"$(JAVAC)" --release 17 $(JDI_MODULE) -d "$(MAIN_CLASSES)" $(MAIN_SOURCES)

jar: classes
	@mkdir -p "$(BUILD_DIR)"
	"$(JAR)" --create --file "$(JAR_FILE)" --main-class "$(MAIN_CLASS)" -C "$(MAIN_CLASSES)" .

test: jar
	@mkdir -p "$(TEST_CLASSES)"
	"$(JAVAC)" --release 17 $(JDI_MODULE) -cp "$(MAIN_CLASSES)" -d "$(TEST_CLASSES)" $(TEST_SOURCES)
	"$(JAVA)" $(JDI_MODULE) -cp "$(MAIN_CLASSES):$(TEST_CLASSES)" "$(TEST_CLASS)"
	"$(JAVA)" $(JDI_MODULE) -cp "$(MAIN_CLASSES):$(TEST_CLASSES)" "io.liveprobe.bridge.MainSmokeTest"

clean:
	rm -rf "$(BUILD_DIR)"
