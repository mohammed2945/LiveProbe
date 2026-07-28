#include <stdint.h>

__attribute__((noinline, visibility("default"))) int64_t fbreg_fixture(int64_t input) {
    volatile int64_t first_local = input + 1;
    volatile int64_t fbreg_known = input + 2;
    volatile int64_t third_local = input + 3;
    __asm__ volatile(".globl native_fbreg_probe_site\nnative_fbreg_probe_site:" : "+m"(fbreg_known) : : "memory"); /* FBREG_PROBE_LINE */
    return first_local + fbreg_known + third_local;
}

int main(void) {
    return fbreg_fixture(4240) == 12726 ? 0 : 1;
}
