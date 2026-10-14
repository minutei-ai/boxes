#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn proc_signal_mask_v2(
        how: u32,
        low: u32,
        high: u32,
        old_low: *mut u32,
        old_high: *mut u32,
    ) -> u32;
}

#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        let mut low = 91;
        let mut high = 92;
        if proc_signal_mask_v2(3, u32::MAX, u32::MAX, &mut low, &mut high) != 0
            || low != 0
            || high != 0
        {
            return 1;
        }
        if proc_signal_mask_v2(0, 1 << 1, 1 << 31, &mut low, &mut high) != 0
            || low != 0
            || high != 0
        {
            return 2;
        }
        if proc_signal_mask_v2(3, 0, 0, &mut low, &mut high) != 0 || low != 2 || high != 1 << 31 {
            return 3;
        }
        if proc_signal_mask_v2(0, (1 << 8) | (1 << 18) | (1 << 14), 0, &mut low, &mut high) != 0
            || low != 2
            || high != 1 << 31
        {
            return 4;
        }
        if proc_signal_mask_v2(1, 2, 0, &mut low, &mut high) != 0
            || low != (2 | (1 << 14))
            || high != 1 << 31
        {
            return 5;
        }
        if proc_signal_mask_v2(2, 1, 1, &mut low, &mut high) != 0
            || low != 1 << 14
            || high != 1 << 31
        {
            return 6;
        }
        low = 91;
        if proc_signal_mask_v2(2, u32::MAX, u32::MAX, &mut low, u32::MAX as *mut u32) != 21
            || low != 91
        {
            return 7;
        }
        if proc_signal_mask_v2(3, 0, 0, &mut low, &mut high) != 0 || low != 1 || high != 1 {
            return 8;
        }
        if proc_signal_mask_v2(2, 1 << 31, 0, &mut low, &mut high) != 0 {
            return 12;
        }
        if proc_signal_mask_v2(3, 0, 0, &mut low, &mut high) != 0 || low != 1 << 31 || high != 0 {
            return 13;
        }
        low = 91;
        high = 92;
        if proc_signal_mask_v2(4, 0, 0, &mut low, &mut high) != 28 || low != 91 || high != 92 {
            return 9;
        }
        if proc_signal_mask_v2(2, u32::MAX, u32::MAX, &mut low, &mut high) != 0 {
            return 10;
        }
        if proc_signal_mask_v2(3, 0, 0, &mut low, &mut high) != 0
            || low != (u32::MAX & !((1 << 8) | (1 << 18)))
            || high != u32::MAX
        {
            return 11;
        }
        0
    }
}
