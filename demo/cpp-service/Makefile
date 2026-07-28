CXX ?= g++
CXXFLAGS := -std=c++20 -O2 -g -fno-omit-frame-pointer -Wall -Wextra -Werror
LDFLAGS := -Wl,--build-id=sha1 -pthread

.PHONY: all clean
all: liveprobe-cpp-demo

liveprobe-cpp-demo: main.cpp
	$(CXX) $(CXXFLAGS) $< $(LDFLAGS) -o $@
	@readelf --notes $@ | grep -q 'Build ID:'

clean:
	rm -f liveprobe-cpp-demo
