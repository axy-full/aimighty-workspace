#!/bin/zsh
# Test-slot semaphore: 6 slots = at most 6 mock servers + 6 test runners (12 heavy workers; owner raised from 4 on 28 Sep).
#   slot.sh acquire <lane> [reserve] -> prints "slot-N" (and holds it) or "none"; [reserve] = slots that must stay
#                                       free for higher-priority lanes after this one takes a slot (default 0)
#   slot.sh release <lane>   -> frees every slot held by <lane>
#   slot.sh status           -> who holds what
# slots/.max-slots (optional) caps slots held at once; owner overnight rule 5 Oct = 1 (heavy browser suites one at a time).
D=/Users/axy/Documents/Codex/2026-09-13/vercel-plugin-vercel-openai-curated-remote-4/work/HANDOFF-2026-09-27-claude-resume/claude-session/slots
cmd=$1; lane=$2; reserve=${3:-0}
case $cmd in
  acquire)
    free=$(memory_pressure | tail -n 1 | grep -oE '[0-9]+%' | tr -d %)
    if (( free < 40 )); then echo "none (memory free ${free}% < 40%)"; exit 1; fi
    cap=$(cat $D/.reserve-cap 2>/dev/null); [[ -n $cap ]] && (( reserve > cap )) && reserve=$cap
    open=0; for n in 1 2 3 4 5 6; do [[ -d $D/slot-$n ]] || (( open++ )); done
    max=$(cat $D/.max-slots 2>/dev/null); max=${max:-6}; held=$(( 6 - open ))
    if (( held >= max )); then echo "none (overnight limit: $max slot(s) at a time; $held held)"; exit 1; fi
    if (( open - 1 < reserve )); then echo "none (keeping $reserve slot(s) for higher-priority lanes; $open free)"; exit 1; fi
    for n in 1 2 3 4 5 6; do
      if mkdir $D/slot-$n 2>/dev/null; then echo $lane > $D/slot-$n/owner; date -u +%FT%TZ >> $D/slot-$n/owner; echo slot-$n; exit 0; fi
    done
    echo none; exit 1;;
  release)
    for n in 1 2 3 4 5 6; do [[ -f $D/slot-$n/owner && $(head -1 $D/slot-$n/owner) == $lane ]] && rm -f $D/slot-$n/owner && rmdir $D/slot-$n && echo "released slot-$n"; done; exit 0;;
  status)
    for n in 1 2 3 4 5 6; do [[ -d $D/slot-$n ]] && echo "slot-$n: $(tr '\n' ' ' < $D/slot-$n/owner)" || echo "slot-$n: free"; done
    memory_pressure | tail -n 1;;
esac
