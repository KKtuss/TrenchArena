#![no_std]

pub mod error;
pub mod helpers;
pub mod process;
pub mod state;

use pinocchio::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult};

/// Program ID: 26fttiarz4KzXfcyB5W24WfXpMw8UqZHqKoTF9wWm2Ke
///
/// Hardcoded bytes (pinocchio 0.8.4 has no `declare_id!`; keep in sync with Anchor).
pub const ID: Pubkey = [
    16, 79, 145, 191, 175, 75, 170, 188, 180, 85, 162, 212, 237, 28, 62, 156, 64, 164, 115, 60,
    104, 204, 179, 170, 170, 187, 118, 24, 168, 173, 77, 205,
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

#[cfg(feature = "bpf-entrypoint")]
program_entrypoint!(process_instruction);

#[cfg(feature = "bpf-entrypoint")]
default_allocator!();

#[cfg(feature = "bpf-entrypoint")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}
