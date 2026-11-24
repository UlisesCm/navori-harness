"""Claude: Bash calls whose write token is only in the output (rung 1 yes, rung 2 no)."""
import glob, json, os
from lanes_probe import has_write_token, text_of
HOME = os.path.expanduser("~")
tot = cmd_tok = payload_tok = 0
for path in glob.glob(f"{HOME}/.claude/projects/*navori*/*.jsonl"):
    uses = {}
    for line in open(path, errors="replace"):
        try: o = json.loads(line)
        except ValueError: continue
        if o.get("isSidechain"): continue
        c0 = (o.get("message") or {}).get("content")
        if not isinstance(c0, list): continue
        for c in c0:
            if not isinstance(c, dict): continue
            if c.get("type") == "tool_use": uses[c.get("id")] = (c.get("name"), c.get("input") or {})
            elif c.get("type") == "tool_result" and not c.get("is_error"):
                n, inp = uses.get(c.get("tool_use_id"), (None, {}))
                if n != "Bash": continue
                tot += 1
                cmd = inp.get("command", "")
                full = json.dumps(inp, separators=(",", ":")) + json.dumps(text_of(c.get("content")))
                if has_write_token(full): payload_tok += 1
                if has_write_token(cmd): cmd_tok += 1
print(f"claude bash={tot} token_en_payload={payload_tok} ({100*payload_tok/tot:.1f} %) token_en_comando={cmd_tok} ({100*cmd_tok/tot:.1f} %) falsos_positivos={payload_tok-cmd_tok} ({100*(payload_tok-cmd_tok)/tot:.1f} % de los Bash)")
