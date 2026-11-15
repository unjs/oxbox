// Replaces crates.io `bytecount`: its wasm32 code always enables `simd128` per function, which LLVM spreads to the whole module
pub fn count(haystack: &[u8], needle: u8) -> usize {
    haystack.iter().filter(|&&b| b == needle).count()
}
