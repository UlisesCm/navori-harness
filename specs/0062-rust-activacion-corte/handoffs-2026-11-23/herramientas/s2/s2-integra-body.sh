#!/usr/bin/env bash
# Usage: s2-integra-body.sh <pr> <head> <base> <run> <q/qb> <p/pb> <o/ob> <extra-markdown-file>: appends the integration section.
set -euo pipefail
N=$1; H=$2; B=$3; R=$4; Q=$5; P=$6; O=$7; X=$8
cd $HOME/Documentos/dev/personal/navori-harness
gh pr view "$N" --json body -q .body > /tmp/s2-body-$N.md
{
cat /tmp/s2-body-$N.md
printf '\n## Integración (S2)\n\nSe rebasó sobre `%s`, el head de `migration/rust` en ese momento. Esta tabla reemplaza a la de delta anterior. Rust coexistence del head `%s` (run %s), comparado con el CI del push de la base `%s`:\n\n' "$B" "$H" "$R" "$B"
printf '| Job | Base `%s` | Rama | Nuevos | Quitados |\n| -- | -- | -- | -- | -- |\n' "$B"
printf '| `quality` (cargo, nombres en rojo) | %s | %s | 0 | %s |\n' ${Q//\// }
printf '| `post-cutover` | %s | %s | 0 | %s |\n' ${P//\// }
printf '| `oracle` (ids en rojo) | %s | %s | 0 | %s |\n\n' ${O//\// }
cat "$X"
} > /tmp/s2-body-$N.new.md
gh pr edit "$N" --body-file /tmp/s2-body-$N.new.md >/dev/null && echo body-ok
