#[link(wasm_import_module = "host_user")]
unsafe extern "C" {
    fn getuid(output: *mut u32) -> u32;
    fn geteuid(output: *mut u32) -> u32;
    fn getgid(output: *mut u32) -> u32;
    fn getegid(output: *mut u32) -> u32;
}

#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn proc_getrlimit(resource: u32, soft: *mut u64, hard: *mut u64) -> u32;
}

fn main() {
    for read in [getuid, geteuid, getgid, getegid] {
        let mut value = u32::MAX;
        assert_eq!(unsafe { read(&mut value) }, 0);
        assert_eq!(value, 0);
        assert_eq!(unsafe { read((u32::MAX - 1) as *mut u32) }, 21);
        value = u32::MAX;
        assert_eq!(unsafe { read(&mut value) }, 0);
        assert_eq!(value, 0);
    }
    let mut soft = 99;
    let mut hard = 99;
    assert_eq!(unsafe { proc_getrlimit(7, &mut soft, &mut hard) }, 0);
    assert_eq!((soft, hard), (132, 132));
    soft = 99;
    assert_eq!(
        unsafe { proc_getrlimit(7, &mut soft, (u32::MAX - 1) as *mut u64) },
        21
    );
    assert_eq!(soft, 99);
    assert_eq!(
        unsafe { proc_getrlimit(u32::MAX, &mut soft, &mut hard) },
        28
    );
    assert_eq!(unsafe { proc_getrlimit(0, &mut soft, &mut hard) }, 58);
    println!("virtual identity and resource bounds verified");
}
