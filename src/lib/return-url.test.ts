import { describe, expect, it } from "vitest";
import { loginReturnTo, safeReturnTo } from "./return-url";

describe("safeReturnTo", () => {
  it.each([
    ["/products/abc", "/products/abc"],
    ["/products/abc?color=blue#detail", "/products/abc?color=blue#detail"],
    ["/account", "/account"],
  ])("保留合法站內相對路徑 %s", (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });

  it.each([
    "https://evil.example/phish",
    "//evil.example/phish",
    "/\\evil.example/phish",
    "javascript:alert(1)",
    "products/abc",
    "\n/products/abc",
  ])("拒絕可能造成 open redirect 的值 %s", (input) => {
    expect(safeReturnTo(input)).toBe("/");
  });

  it("登入頁不允許 returnTo 再指回登入頁造成循環", () => {
    expect(loginReturnTo("/login?returnTo=/account")).toBe("/");
  });
});
