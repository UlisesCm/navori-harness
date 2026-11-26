"""Which routing-watch lane each real call takes (read-only over transcripts).

Approximates the hook's payload as tool input JSON + tool result text and applies the hook's
own cheap probes: tool discriminator, navori_has_write_token (routing-watch.sh:1147-1185, on
the WHOLE payload), payload size, and "first Bash success after a failed Bash" (Claude
bash-outcome reset lane with node). Prints lane fractions per engine.
"""
import glob
import json
import os
import statistics

HOME = os.path.expanduser("~")
import sys
# The Pi bridge payload carries no tool_response (bridge-source.ts:133-144).
PI_NO_RESPONSE = "--pi-with-response" not in sys.argv


def has_write_token(probe):
    p = probe.replace(">&", "").replace(">/dev/null", "").replace("> /dev/null", "")
    if ">" in p:
        return True
    if "tee " in probe:
        return True
    i = probe.find("sed ")
    return i >= 0 and "-i" in probe[i:]


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(c.get("text", "") for c in content if isinstance(c, dict))
    return ""


