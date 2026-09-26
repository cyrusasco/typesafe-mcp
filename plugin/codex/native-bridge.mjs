import { requireThat } from './contracts.mjs';

// Adapter contract for the parent host, not a subprocess/CLI launcher.
// Actual native tool results must be normalized by the host to the receipt shape.
export async function deliverPending(controller, key, host) {
  for (;;) {
    const report = await controller.report({ key });
    const action = report.pending.find(a => a.kind === 'interrupt' && !a.delivery)
      ?? report.pending.find(a => a.kind === 'interrupt') ?? report.pending[0];
    if (!action) return report;
    requireThat(!action.delivery, 'native outcome uncertain/already claimed; reconcile receipt, never resend automatically');
    requireThat(typeof host?.[action.kind] === 'function', `native ${action.kind} capability unavailable`);
    await controller.claim({ key, action_id: action.id }); // durable intent before external effect
    const args = action.kind === 'spawn' ? {
      task_name: action.subtask_id,
      agent_type: action.assignment.role,
      model: action.assignment.model_id,
      reasoning_effort: action.assignment.reasoning_effort,
      fork_turns: 'none',
      message: action.message,
    } : action.kind === 'interrupt' ? { target: action.native_agent_id }
      : { target: action.native_agent_id, message: action.message };
    const receipt = await host[action.kind](args);
    await controller.ack({ key, action_id: action.id, receipt });
  }
}
