// web/lib/api/csrf.test.ts
import { describe, it, expect } from "vitest";
import { csrfOk } from "./csrf";

function makeReq(headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/runs", {
    method: "POST",
    headers,
  });
}

describe("csrfOk", () => {
  it("passes when origin matches host and custom header present", () => {
    const req = makeReq({
      "x-umbrella-request": "1",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    });
    expect(csrfOk(req)).toBe(true);
  });

  it("fails when custom header missing", () => {
    const req = makeReq({
      origin: "http://localhost:3000",
      host: "localhost:3000",
    });
    expect(csrfOk(req)).toBe(false);
  });

  it("fails when origin mismatches host", () => {
    const req = makeReq({
      "x-umbrella-request": "1",
      origin: "http://evil.com",
      host: "localhost:3000",
    });
    expect(csrfOk(req)).toBe(false);
  });

  it("fails when origin missing", () => {
    const req = makeReq({
      "x-umbrella-request": "1",
      host: "localhost:3000",
    });
    expect(csrfOk(req)).toBe(false);
  });
});
