#![cfg_attr(feature = "bpf-entrypoint", no_std)]

pub mod cards;
pub mod error;
pub mod helpers;
pub mod process;
pub mod state;

use pinocchio::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult};

/// Program ID: 6dHMWQd1M2ZZSmrkQLGZcFpHnvHi8rcH68QqQJ4Kj4r8
///
/// Hardcoded bytes (pinocchio 0.8.4 has no `declare_id!`). The deploy script
/// selects the program keypair separately and must not hardcode this id.
pub const ID: Pubkey = [
    83, 149, 213, 181, 86, 206, 134, 195, 242, 127, 247, 149, 76, 39, 76, 198, 149, 178, 255,
    118, 142, 170, 26, 16, 11, 199, 26, 78, 8, 27, 238, 221,
];

#[inline(always)]
pub fn check_id(id: &Pubkey) -> bool {
    id == &ID
}

/// Library entry used by tests and the BPF entrypoint.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if program_id != &ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    process::process(program_id, accounts, instruction_data)
}

#[cfg(feature = "bpf-entrypoint")]
use pinocchio::{default_allocator, program_entrypoint};

#[cfg(all(feature = "bpf-entrypoint", not(test)))]
program_entrypoint!(process_instruction);

#[cfg(all(feature = "bpf-entrypoint", not(test)))]
default_allocator!();

#[cfg(all(feature = "bpf-entrypoint", not(test)))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}
