use std::{io::{Read, Write}, net::TcpListener, thread, time::Duration};

#[repr(i64)]
#[derive(Clone, Copy)]
enum Tier { Free = 0, Pro = 1 }

#[repr(C)]
struct Quote { subtotal: i64, discount: i64, total: i64 }

// Stable probe site: count/log at the function entry; snapshot subtotal, tier,
// and quote.total on the assignment below. Rust monomorphization is exercised
// by calling bounded_adjust for i64 and u64.
#[inline(never)]
fn calculate_quote(subtotal: i64, tier: Tier, tenant_secret: i64) -> Quote {
    std::hint::black_box(tenant_secret);
    let discount = if matches!(tier, Tier::Pro) { subtotal / 5 } else { subtotal / 10 }; // Intentional bug: free users receive a discount.
    let total = bounded_adjust(subtotal - discount, 0_i64);
    Quote { subtotal, discount, total }
}

#[inline(never)] fn bounded_adjust<T: Copy>(value: T, _floor: T) -> T { value }
#[inline(never)] fn cold_marker(value: i64) -> i64 { std::hint::black_box(value) }

fn main() -> std::io::Result<()> {
    let _ = cold_marker(7);
    if std::env::var_os("LIVEPROBE_DISABLE_BACKGROUND").is_none() {
        thread::spawn(|| loop { let _ = calculate_quote(4242, Tier::Free, 31337); let _ = bounded_adjust(42_u64, 0); thread::sleep(Duration::from_millis(100)); });
    }
    let listener = TcpListener::bind(("0.0.0.0", 8083))?;
    for stream in listener.incoming() {
        let mut stream = stream?; let mut request = [0; 1024]; let read = stream.read(&mut request)?;
        if request[..read].starts_with(b"GET /burst ") {
            for _ in 0..5_000 { let _ = calculate_quote(4242, Tier::Pro, 31337); }
        }
        let quote = calculate_quote(4242, Tier::Pro, 31337);
        let body = format!("{{\"subtotal\":{},\"discount\":{},\"total\":{}}}\n", quote.subtotal, quote.discount, quote.total);
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body)?;
    }
    Ok(())
}
