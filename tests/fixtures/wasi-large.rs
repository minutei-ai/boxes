#[used]
static PAYLOAD: [u8; 2_097_152] = [165; 2_097_152];

#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    i32::from(std::hint::black_box(&PAYLOAD)[std::hint::black_box(2_097_151)])
}
