import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { reviewLane, parseVerdict, MAX_DIFF_CHARS, type ExecFn } from "./review";

const SHA = "a".repeat(40);

// A fake exec: git answers from a table; codex writes `reply` to the -o file and exits `code`.
function fakeExec(opts: { sha?: string; diff?: string; reply?: string; codexCode?: number; diffCode?: number }) {
  const calls: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
  const exec: ExecFn = async (cmd, args, o) => {
    calls.push({ cmd, args, env: o.env });
    if (cmd === "git" && args[0] === "rev-parse") {
      return opts.sha === undefined ? { code: 128, stdout: "", stderr: "fatal" } : { code: 0, stdout: opts.sha + "\n", stderr: "" };
    }
    if (cmd === "git" && args[0] === "diff") {
      return { code: opts.diffCode ?? 0, stdout: opts.diff ?? "", stderr: opts.diffCode ? "boom" : "" };
    }
    if (cmd === "codex") {
      const out = args[args.indexOf("-o") + 1];
      if (opts.reply !== undefined) fs.writeFileSync(out, opts.reply);
      return { code: opts.codexCode ?? 0, stdout: "", stderr: opts.codexCode ? "codex failed" : "" };
    }
    throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
  };
  return { exec, calls };
}

describe("parseVerdict", () => {
  it("takes the LAST verdict line, case/markdown tolerant, and summarises findings", () => {
    const r = parseVerdict("High | SECURITY | a.ts:1 | leak | fix\nVERDICT: PASS\n...\n**VERDICT: BLOCK**");
    expect(r.verdict).toBe("BLOCK");
    expect(r.summary).toMatch(/BLOCK: High \| SECURITY/);
    expect(parseVerdict("Low | TESTING | x | y | z\nverdict: pass").verdict).toBe("PASS");
    expect(parseVerdict("looks fine to me").verdict).toBe("ERROR");
  });
});

describe("reviewLane", () => {
  let tmp: string;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });
  const dir = () => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviews-")));

  it("PASS: Codex gets ONLY the instructions + brief + diff, in a fresh read-only ephemeral session; artifact written", async () => {
    const { exec, calls } = fakeExec({ sha: SHA, diff: "diff --git a/x b/x\n+ok\n", reply: "Low | TESTING | x:1 | p | f\nVERDICT: PASS\n" });
    const r = await reviewLane({ slug: "lane-x", brief: "add x", base: "main", repoRoot: "/repo" }, { exec, reviewsDir: dir() });
    expect(r).toEqual({ verdict: "PASS", sha: SHA, summary: "cross-review PASS (1 non-blocking finding)" });
    const codex = calls.find((c) => c.cmd === "codex")!;
    // Full argv: fixed flags, the repo, a temp last-message file, then the prompt LAST (no -m when unset).
    expect(codex.args.slice(0, 7)).toEqual(["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "-C", "/repo"]);
    expect(codex.args[7]).toBe("-o");
    expect(codex.args[8]).toMatch(/gantry-review-.*\/last\.md$/);
    expect(codex.args).toHaveLength(10);
    const prompt = codex.args[codex.args.length - 1];
    expect(prompt).toContain("SPEC:\nadd x");
    expect(prompt).toContain("DIFF:\ndiff --git a/x b/x");
    expect(prompt).not.toMatch(/agent|reasoning|HANDOFF/i); // nothing of the author rides along
    expect(Object.keys(codex.env).every((k) => ["PATH", "HOME", "LANG", "TZ"].includes(k))).toBe(true);
    expect(calls.find((c) => c.cmd === "git" && c.args[0] === "diff")!.args).toEqual(["diff", "main...feat/lane-x"]);
    const rec = JSON.parse(fs.readFileSync(path.join(tmp, `${SHA}.json`), "utf8"));
    expect(rec).toMatchObject({ verdict: "PASS", head: SHA, ref: "feat/lane-x", reviewer: "codex-daemon" });
  });

  it("passes a model override as -m before the prompt", async () => {
    const { exec, calls } = fakeExec({ sha: SHA, diff: "+x", reply: "VERDICT: PASS" });
    await reviewLane({ slug: "lane-x", brief: "b", repoRoot: "/repo", base: "main" }, { exec, reviewsDir: dir(), model: "gpt-5.2-codex" });
    const args = calls.find((c) => c.cmd === "codex")!.args;
    expect(args.slice(9, 11)).toEqual(["-m", "gpt-5.2-codex"]);
    expect(args).toHaveLength(12);
  });

  it("BLOCK: recorded as BLOCK (never unlocks a merge), summary names the blocking finding", async () => {
    const { exec } = fakeExec({ sha: SHA, diff: "+x", reply: "Medium | A | f:1 | m | f\nHigh | SECURITY | f:2 | injection | escape\nVERDICT: BLOCK" });
    const r = await reviewLane({ slug: "lane-x", brief: "b", repoRoot: "/repo", base: "main" }, { exec, reviewsDir: dir() });
    expect(r.verdict).toBe("BLOCK");
    expect(r.summary).toMatch(/High \| SECURITY \| f:2 \| injection/);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, `${SHA}.json`), "utf8")).verdict).toBe("BLOCK");
  });

  it("fails CLOSED with no artifact: unresolvable ref, failed diff, empty diff, oversized diff, codex crash, no verdict", async () => {
    const d = dir();
    const cases: Parameters<typeof fakeExec>[0][] = [
      {},
      { sha: SHA, diffCode: 1 },
      { sha: SHA, diff: "   " },
      { sha: SHA, diff: "+" + "x".repeat(MAX_DIFF_CHARS) },
      { sha: SHA, diff: "+x", codexCode: 2 },
      { sha: SHA, diff: "+x", reply: "all good, ship it" },
    ];
    for (const c of cases) {
      const r = await reviewLane({ slug: "lane-x", brief: "b", repoRoot: "/repo", base: "main" }, { exec: fakeExec(c).exec, reviewsDir: d });
      expect(r.verdict, JSON.stringify(c).slice(0, 60)).toBe("ERROR");
    }
    expect(fs.readdirSync(d)).toEqual([]);
  });
});
