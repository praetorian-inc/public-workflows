// GitHub workflow-command output for the size gate (LAB-7587).

// Escape a workflow-command message so a newline cannot start a new command.
export const escapeData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
