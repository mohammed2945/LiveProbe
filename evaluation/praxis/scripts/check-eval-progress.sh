#!/bin/bash
# Check evaluation progress. Safe to run any time from anywhere.
gcloud compute ssh liveprobe-praxis-eval --zone us-east1-b --project liveprobeeval \
  --command 'echo "=== STATUS ==="; cat /home/veer/DRIVER_STATUS 2>/dev/null;
  if [ -f /home/veer/NEEDS_ATTENTION ]; then echo; echo "*** ACTION NEEDED ***"; cat /home/veer/NEEDS_ATTENTION; fi
  echo; echo "=== LIVE ==="; tmux ls 2>/dev/null | grep -q "^driver:" && echo "driver RUNNING" || echo "driver STOPPED"
  for w in r13 r14; do
    python3 -c "
import json,sys
try:
    d=json.load(open(\"/home/veer/praxis-campaign-$w/campaign.json\"))
    inc=d.get(\"incidents\") or {}
    done=sum(len(r.get(\"completed\") or []) for v in inc.values() for r in (v.get(\"runs\") or []))
    print(\"$w:\", d.get(\"status\"), len(d.get(\"results\") or []), \"/54 runs\")
except Exception: pass
" 2>/dev/null; done' 2>/dev/null | grep -vE "WARNING|vulnerable|openssh|upgraded"
