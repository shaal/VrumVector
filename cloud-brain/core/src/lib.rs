//! The cloud brain service without the Workers runtime (docs/plan/cloud-brain.md,
//! CB2): the wire format, and the shared brain itself (storage-agnostic), so
//! all of it is tested natively with `cargo test`.

pub mod brain;
pub mod wire;
