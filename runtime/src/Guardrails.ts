export type GuardrailDecision = { allowed: true } | { allowed: false; escalate: true; reason: string };
const BLOCKED_SHELL = [/(^|\s)(sudo|su|mkfs|dd|shutdown|reboot|iptables|useradd|passwd)(\s|$)/i,
  /\brm\s+-rf\s+\/(?:\s|$)/i, /:\(\)\s*\{\s*:\|:&\s*\};:/, />\s*\/dev\/(?:sd|nvme)/i];
const MUTATING_SQL = /^\s*(DROP|TRUNCATE|ALTER|DELETE|UPDATE|INSERT|CREATE|GRANT|REVOKE)\b/i;
const DANGEROUS_DDL = /^\s*(DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i;

export function validateShell(command: string, args: string[] = []): GuardrailDecision {
  const full = [command, ...args].join(' ');
  if (!command || command.length > 200 || args.length > 100 || args.some(arg => arg.length > 8000)) return { allowed: false, escalate: true, reason: 'Shell request exceeds safe limits.' };
  const executable=command.split(/[\\/]/).at(-1)?.toLowerCase();
  if (['sh','bash','zsh','dash','cmd','powershell','pwsh'].includes(executable||'') ||
      (['node','python','python3','ruby','perl','php'].includes(executable||'')&&args.some(arg=>arg==='-c'||arg==='-e'||arg==='--eval')) ||
      BLOCKED_SHELL.some(pattern => pattern.test(full)) || /(?:;|&&|\|\||\||\$\(|`|\n|\r)/.test(full)) return { allowed: false, escalate: true, reason: 'Potentially destructive or chained shell command requires approval.' };
  return { allowed: true };
}
export function validateSql(sql: string, _parameterized = false): GuardrailDecision {
  if (!sql.trim() || sql.length > 20_000 || /;\s*\S/.test(sql)) return { allowed: false, escalate: true, reason: 'Malformed or multi-statement SQL blocked.' };
  if (DANGEROUS_DDL.test(sql)) return { allowed: false, escalate: true, reason: 'DDL and privilege changes are blocked by the deterministic database guard.' };
  if (MUTATING_SQL.test(sql)) return { allowed: false, escalate: true, reason: 'Raw SQL mutations are blocked; use a scoped Prisma operation after approval.' };
  if (/\b(DROP\s+DATABASE|DROP\s+SCHEMA|TRUNCATE\s+CASCADE)\b/i.test(sql)) return { allowed: false, escalate: true, reason: 'Destructive database operation blocked.' };
  return { allowed: true };
}
