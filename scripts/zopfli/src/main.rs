// stdin -> raw deflate (zopfli) -> stdout; argv[1] is the iteration count
use std::io::{Read, Write, stdin, stdout};
use std::num::NonZeroU64;
use zopfli::{BlockType, DeflateEncoder, Options};

fn main() {
    let iterations = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .and_then(NonZeroU64::new);
    let options = Options {
        iteration_count: iterations.unwrap_or(NonZeroU64::new(15).unwrap()),
        ..Default::default()
    };
    let mut input = Vec::new();
    stdin().read_to_end(&mut input).unwrap();
    let mut encoder = DeflateEncoder::new(options, BlockType::Dynamic, stdout().lock());
    // Fixed chunks (zopfli's 1MB master blocks) so output doesn't depend on how stdin is read
    for chunk in input.chunks(1_000_000) {
        encoder.write_all(chunk).unwrap();
    }
    encoder.finish().unwrap().flush().unwrap();
}
