#include <chrono>
#include <cstdlib>
#include <cstring>
#include <netinet/in.h>
#include <string>
#include <string_view>
#include <thread>
#include <unistd.h>

enum class Tier : long { Free = 0, Pro = 1 };
struct Quote { long subtotal; long discount; long total; };
volatile long background_total = 0;

template <typename T> __attribute__((noinline)) T bounded_adjust(T value, T) { return value; }
__attribute__((noinline)) long cold_marker(long value) { asm volatile("" : "+r"(value)); return value; }

// Stable probe site. The free-tier discount is the intentional demo bug.
extern "C" __attribute__((noinline)) Quote calculate_quote(long subtotal, Tier tier, long tenant_secret) {
  asm volatile("" : "+r"(tenant_secret) : : "memory");
  const long discount = tier == Tier::Pro ? subtotal / 5 : subtotal / 10;
  const long total = bounded_adjust(subtotal - discount, 0L);
  return Quote{subtotal, discount, total};
}

int main() {
  (void)cold_marker(7);
  if (std::getenv("LIVEPROBE_DISABLE_BACKGROUND") == nullptr) {
    std::thread traffic([] { for (;;) { background_total = calculate_quote(4242, Tier::Free, 31337).total; (void)bounded_adjust<unsigned long>(42, 0); std::this_thread::sleep_for(std::chrono::milliseconds(100)); } });
    traffic.detach();
  }
  int server = socket(AF_INET, SOCK_STREAM, 0); int reuse = 1; setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
  sockaddr_in address{}; address.sin_family = AF_INET; address.sin_port = htons(8084); address.sin_addr.s_addr = INADDR_ANY;
  if (bind(server, reinterpret_cast<sockaddr*>(&address), sizeof(address)) || listen(server, 16)) return 1;
  for (;;) {
    int client = accept(server, nullptr, nullptr);
    if (client < 0) continue;
    char request[1024];
    ssize_t bytes_read = read(client, request, sizeof(request));
    if (bytes_read <= 0) { close(client); continue; }
    if (std::string_view(request, static_cast<size_t>(bytes_read)).starts_with("GET /burst ")) {
      for (int index = 0; index < 5000; ++index) (void)calculate_quote(4242, Tier::Pro, 31337);
    }
    Quote quote = calculate_quote(4242, Tier::Pro, 31337);
    std::string body = "{\"subtotal\":" + std::to_string(quote.subtotal) +
      ",\"discount\":" + std::to_string(quote.discount) +
      ",\"total\":" + std::to_string(quote.total) + "}\n";
    std::string response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
      std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
    ssize_t bytes_written = write(client, response.data(), response.size());
    if (bytes_written < 0) { close(client); continue; }
    close(client);
  }
}
