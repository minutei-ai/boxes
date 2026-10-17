use miniz_oxide::deflate::compress_to_vec_zlib;
use miniz_oxide::inflate::{
    TINFLStatus,
    core::{DecompressorOxide, decompress, inflate_flags},
};
use wasm_bindgen::prelude::*;

const PAGE_BYTES: usize = 65_536;
const PACK_BYTES: usize = PAGE_BYTES * 16;
const ENCODED_LIMIT: usize = PACK_BYTES + PACK_BYTES / 128 + 64;

#[wasm_bindgen]
pub fn pack_memory(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() > PACK_BYTES || !bytes.len().is_multiple_of(PAGE_BYTES) {
        return Err("Invalid memory pack length".into());
    }
    let encoded = compress_to_vec_zlib(bytes, 1);
    if encoded.len() > ENCODED_LIMIT {
        return Err("Compressed memory pack exceeds its limit".into());
    }
    Ok(encoded)
}

#[wasm_bindgen]
pub fn unpack_memory(bytes: &[u8], expected_bytes: u32) -> Result<Vec<u8>, String> {
    let expected = expected_bytes as usize;
    if expected == 0 || expected > PACK_BYTES || !expected.is_multiple_of(PAGE_BYTES) {
        return Err("Invalid restored memory pack length".into());
    }
    if bytes.is_empty() || bytes.len() > ENCODED_LIMIT {
        return Err("Invalid compressed memory pack length".into());
    }
    let mut state = Box::<DecompressorOxide>::default();
    let mut output = vec![0; expected];
    let flags = inflate_flags::TINFL_FLAG_PARSE_ZLIB_HEADER
        | inflate_flags::TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF;
    let (status, consumed, produced) = decompress(&mut state, bytes, &mut output, 0, flags);
    if status != TINFLStatus::Done || consumed != bytes.len() || produced != expected {
        return Err("Invalid or oversized compressed memory pack".into());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_packs_round_trip_incompressible_and_repeated_data_at_page_boundaries() {
        for pages in [1, 4, 16] {
            let mut state = 0x9e37_79b9u32;
            let bytes: Vec<u8> = (0..pages * PAGE_BYTES)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 17;
                    state ^= state << 5;
                    state as u8
                })
                .collect();
            for input in [&bytes, &vec![0; pages * PAGE_BYTES]] {
                let encoded = pack_memory(input).unwrap();
                assert!(encoded.len() <= ENCODED_LIMIT);
                assert_eq!(unpack_memory(&encoded, input.len() as u32).unwrap(), *input);
            }
        }
    }

    #[test]
    fn memory_packs_reject_invalid_layouts_before_compression_or_inflation() {
        for length in [0, PAGE_BYTES - 1, PAGE_BYTES + 1, PACK_BYTES + PAGE_BYTES] {
            assert!(pack_memory(&vec![0; length]).is_err());
            assert!(unpack_memory(&[0], length as u32).is_err());
        }
        assert!(unpack_memory(&[], PAGE_BYTES as u32).is_err());
        assert!(unpack_memory(&vec![0; ENCODED_LIMIT + 1], PAGE_BYTES as u32).is_err());
    }

    #[test]
    fn memory_packs_reject_corruption_truncation_trailing_bytes_and_expansion() {
        let encoded = pack_memory(&vec![42; PAGE_BYTES]).unwrap();
        let mut corrupt = encoded.clone();
        let last = corrupt.len() - 1;
        corrupt[last] ^= 1;
        assert!(unpack_memory(&corrupt, PAGE_BYTES as u32).is_err());
        for length in [1, encoded.len() / 2, encoded.len() - 1] {
            assert!(unpack_memory(&encoded[..length], PAGE_BYTES as u32).is_err());
        }
        let mut trailing = encoded.clone();
        trailing.push(0);
        assert!(unpack_memory(&trailing, PAGE_BYTES as u32).is_err());
        assert!(unpack_memory(&encoded, (PAGE_BYTES * 2) as u32).is_err());
        let bomb = compress_to_vec_zlib(&vec![0; PACK_BYTES * 4], 1);
        assert!(unpack_memory(&bomb, PACK_BYTES as u32).is_err());
    }
}
