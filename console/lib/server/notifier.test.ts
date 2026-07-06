import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { notify } from "./notifier";

const OLD = { url: process.env.NTFY_URL, topic: process.env.NTFY_TOPIC, base: process.env.CONSOLE_BASE_URL };

afterEach(() => {
  process.env.NTFY_URL = OLD.url;
  process.env.NTFY_TOPIC = OLD.topic;
  process.env.CONSOLE_BASE_URL = OLD.base;
  vi.restoreAllMocks();
});

describe("ntfy notifier", () => {
  beforeEach(() => {
    process.env.NTFY_URL = "https://ntfy.example.com";
    process.env.NTFY_TOPIC = "harness-alerts";
    process.env.CONSOLE_BASE_URL = "https://console.tail.net";
  });

  it("POSTs to NTFY_URL/NTFY_TOPIC with title, priority, tags and deep-link", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    const sent = await notify(
      { kind: "gate-raised", runId: "r1", projectName: "vector", detail: "Gate B raised on px-b" },
      fetchMock as unknown as typeof fetch
    );
    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ntfy.example.com/harness-alerts");
    expect(opts.method).toBe("POST");
    const h = opts.headers as Record<string, string>;
    expect(h.Title).toContain("vector");
    expect(h.Priority).toBe("high");
    expect(h.Click).toBe("https://console.tail.net/runs/r1");
    expect(opts.body).toBe("Gate B raised on px-b");
  });

  it("is a NO-OP (no fetch) when NTFY env is unset", async () => {
    delete process.env.NTFY_URL;
    delete process.env.NTFY_TOPIC;
    const fetchMock = vi.fn();
    const sent = await notify({ kind: "run-completed", runId: "r1", projectName: "ledger" }, fetchMock as unknown as typeof fetch);
    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("run-completed uses default priority + check tag", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    await notify({ kind: "run-completed", runId: "r1", projectName: "ledger" }, fetchMock as unknown as typeof fetch);
    const h = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(h.Priority).toBe("default");
    expect(h.Tags).toBe("white_check_mark");
  });

  it("swallows fetch errors and returns false (never blocks a run)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    const sent = await notify({ kind: "run-failed", runId: "r1", projectName: "vector" }, fetchMock as unknown as typeof fetch);
    expect(sent).toBe(false);
  });
});
