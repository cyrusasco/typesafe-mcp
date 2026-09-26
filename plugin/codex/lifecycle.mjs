// Advisory lifecycle context only. No key reads, model calls or tool interception.
let raw = '';
for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > 128000) process.exit(1); }
try {
  const input = JSON.parse(raw);
  if (input.hook_event_name === 'UserPromptSubmit') process.stdout.write(JSON.stringify({hookSpecificOutput:{
    hookEventName:'UserPromptSubmit',
    additionalContext:'TypeSafe Codex governance: load typesafe-codex. For each user command, first prepare a scoped English plan for Jev. Use fresh native capabilities/Skills and matching GitNexus evidence. Do not bypass Jev or fabricate availability. Service native action receipts and feed progress while children run. If the required tool is absent, report the exact integration gap.'
  }}));
  else if (input.hook_event_name === 'SubagentStart') process.stdout.write(JSON.stringify({hookSpecificOutput:{
    hookEventName:'SubagentStart',
    additionalContext:'When dispatched by the TypeSafe parent, wait for explicit native-ID binding and assignment. Do not perform task work during WAIT. Execute only the assigned scope, load the assigned canonical Skills, and send progress/test/diff evidence to parent. No nested dispatch. Permissions remain those of the parent context.'
  }}));
} catch { process.stderr.write('invalid lifecycle payload\n'); process.exitCode = 1; }
