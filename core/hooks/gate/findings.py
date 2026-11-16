"""`Findings`: the deny/ask list an `Analyzer` builds, and how hidden text is judged.

Every check appends a finding; `verdict` returns the strictest one (deny before ask) with a
count of the others. `raw_deny`, `opaque` and `unparseable` judge text the gate can't walk —
built at run time, nested too deep, or unparseable: a deny pattern in the raw text is a deny,
otherwise the call gets "ask" when there is something to protect.
"""

import re


def norm_lower(s):
    return " ".join(s.lower().split())


def short(text, n=90):
    t = " ".join(text.split())
    return t if len(t) <= n else t[:n - 1] + "…"


class Findings(object):
    def deny(self, why):
        self.findings.append(("deny", why))

    def ask(self, why):
        self.findings.append(("ask", why))

    def verdict(self):
        for level in ("deny", "ask"):
            hits = [w for (lv, w) in self.findings if lv == level]
            if hits:
                uniq = []
                for h in hits:
                    if h not in uniq:
                        uniq.append(h)
                more = " (+%d more)" % (len(uniq) - 1) if len(uniq) > 1 else ""
                return level, uniq[0] + more
        return None

    # -- hidden text ----------------------------------------------------------
    def raw_deny(self, text):
        t = norm_lower(text)
        for p in self.ctx.deny_pats:
            if p.norm and p.norm in t:
                self.deny("`%s` is forbidden by the project's gate, and it appears in text "
                          "that will be executed" % p.text)
                return True
        return False

    def opaque(self, what, text):
        if self.raw_deny(text):
            return
        if self.ctx.has_rules or re.search(r"git|push", text, re.I):
            self.ask("%s, so the gate can't check it against the rules — confirm (`%s`)"
                     % (what, short(text)))

    def unparseable(self, text, err):
        if self.raw_deny(text):
            return
        if self.ctx.has_rules or re.search(r"git|push|\.claude", text, re.I):
            self.ask("the gate can't parse this command (%s), so it can't verify it — confirm"
                     % err)
