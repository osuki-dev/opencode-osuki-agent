// This is an accident-prevention policy, not a sandbox for arbitrary programs.
export function dangerousShell(command: string): string | undefined {
  const c = command.replace(/\\\r?\n/g, " ").replace(/["']/g, "")
  if (
    /(?:^|[\s;&|()])(?:[\w./-]+\/)?(?:sudo|doas|mkfs(?:\.[\w]+)?|wipefs|fdisk|sfdisk|parted|shutdown|reboot|poweroff)(?:\s|$)/i.test(
      c
    )
  )
    return "privileged or system-destructive command"
  if (/\brm\s+[^;&|\n]*(?:--recursive|-[a-zA-Z]*[rR])/.test(c))
    return "recursive deletion; use explicit non-recursive removals or move to a recovery directory"
  if (/\b(?:find)\s+[^;&|\n]*-delete\b/.test(c)) return "bulk deletion"
  if (
    /\bgit\b[^;&|\n]*\b(?:reset\s+[^;&|\n]*--hard|clean\s+[^;&|\n]*-[a-zA-Z]*f|push\s+[^;&|\n]*(?:--force\b|--force-with-lease\b|-[a-zA-Z]*f\b|\+[^\s]+)|checkout\s+--|restore\b)/.test(
      c
    )
  )
    return "destructive Git operation"
  if (
    /\b(?:drop\s+(?:database|schema)|truncate\s+(?:table\s+)?\w+)\b/i.test(c) ||
    /\b(?:dropdb|redis-cli\b[^;&|\n]*\bflush(?:all|db))\b/i.test(c)
  )
    return "bulk database deletion"
  if (/\b(?:dd|shred)\b[^;&|\n]*(?:of=)?\/dev\//.test(c) || />\s*\/dev\/(?:sd|nvme|vd|mapper)/.test(c))
    return "disk overwrite"
  if (/\b(?:curl|wget)\b[^\n]*\|\s*(?:bash|sh|zsh)\b/.test(c)) return "execute an uninspected remote script"
  return undefined
}

export const READ_ONLY_ACTIONS = new Set([
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "skill",
  "execute",
  "tool_search",
  "osuki_review_report",
  "osuki_status"
])
