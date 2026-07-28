#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

__attribute__((noinline, visibility("default"))) int native_test_target(int value) {
    asm volatile("" : "+r"(value) : : "memory");
    return value + 1;
}

__attribute__((noinline, visibility("default"))) int native_count_target(int value) {
    asm volatile("" : "+r"(value) : : "memory");
    return value + 1;
}

__attribute__((noinline, visibility("default"))) long native_fbreg_target(long input) {
    volatile long first_local = input + 1;
    volatile long fbreg_known = input + 2;
    volatile long third_local = input + 3;
    asm volatile(".globl native_fbreg_probe_site\nnative_fbreg_probe_site:" : "+m"(fbreg_known) : : "memory");
    return first_local + fbreg_known + third_local;
}

int main(int argc, char **argv) {
    if (argc != 5) return 2;
    int value = atoi(argv[1]); int ready = atoi(argv[2]); int go = atoi(argv[3]); int done = atoi(argv[4]); char byte;
    if (write(ready, "R", 1) != 1 || read(go, &byte, 1) != 1) return 3;
    for (int index = 0; index < 1000; index++)
        if (native_count_target(index) != index + 1) return 4;
    if (native_test_target(value) != value + 1 || native_fbreg_target(4240) != 12726) return 5;
    if (write(done, "D", 1) != 1 || read(go, &byte, 1) != 1) return 6;
    for (int index = 0; index < 1000; index++)
        if (native_count_target(index) != index + 1) return 7;
    return 0;
}
