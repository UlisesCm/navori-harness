//! Pure hook implementations; registration and process effects belong to the CLI, except the
//! `navori` call a hook makes itself (`plan_gate::call`, over `shell::subcommand`).

pub mod general_purpose_confirm;
pub mod guard_destructive;
pub mod master_accept_confirm;
pub mod master_plan_context;
pub mod model_advisor;
pub mod plan_gate;
pub mod quality_gate_pre_commit;
pub mod session_start_context;
pub mod subagent_no_background;
pub mod subagent_stop_handoff;
