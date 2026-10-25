import { expect, test } from "bun:test";
import { categoryOf, nameRisk } from "../../src/permission/tool-name-risk";

test("nameRisk: mutating verb is consequential, read verbs are read, else unknown", () => {
  expect(nameRisk("gmail_send_email")).toBe("consequential");
  expect(nameRisk("stripe_create_charge")).toBe("consequential");
  expect(nameRisk("list_issues")).toBe("read");
  expect(nameRisk("search_docs")).toBe("read");
  expect(nameRisk("frobnicate")).toBe("unknown");
});

test("nameRisk: monitoring read names are read, a mutating or unmatched name is not", () => {
  for (const t of [
    "whoami",
    "whatis",
    "k8s_pod_status",
    "loki_pod_logs",
    "prometheus_alerts",
    "loki_label_values",
  ])
    expect(nameRisk(`mcp__apero-devops__${t}`)).toBe("read");
  // A sensitive word, a mutating verb or no known word still asks.
  for (const t of ["vibecode_list_secret", "release_apply", "release_rollback"])
    expect(nameRisk(`mcp__apero-devops__${t}`)).not.toBe("read");
  expect(nameRisk("mcp__apero-devops__vibecode_set_env")).toBe("consequential");
});

test("nameRisk: compound names with a verb are consequential", () => {
  expect(nameRisk("get_and_delete")).toBe("consequential");
  expect(nameRisk("get_then_notify")).toBe("consequential");
  expect(nameRisk("list_or_search_items")).toBe("consequential");
  expect(nameRisk("sync_and_notify")).toBe("consequential");
  expect(nameRisk("foo_or_bar")).toBe("consequential");
  expect(nameRisk("salt_and_pepper")).toBe("consequential");
  // A token must equal a compound word.
  expect(nameRisk("list_android_orders")).toBe("read");
  expect(nameRisk("get_sandbox_info")).toBe("read");
});

test("nameRisk: camelCase, hyphens and the mcp prefix", () => {
  expect(nameRisk("sendEmail")).toBe("consequential");
  expect(nameRisk("delete-file")).toBe("consequential");
  expect(nameRisk("getIssueList")).toBe("read");
  expect(nameRisk("mcp__gmail__SendMessage")).toBe("consequential");
  // The server name is not part of the tool's own name.
  expect(nameRisk("mcp__post_office__list_items")).toBe("read");
});

test("nameRisk: a token must equal a verb, a substring is not enough", () => {
  expect(nameRisk("postgres_query")).toBe("read");
  expect(nameRisk("sender_info")).toBe("unknown");
  expect(nameRisk("setup_state")).toBe("unknown");
});

test("categoryOf: email and purchase", () => {
  expect(categoryOf("gmail_send_email", "gmail")).toBe("email");
  expect(categoryOf("gmail_send_email", "")).toBe("email");
  expect(categoryOf("send_message", "outlook")).toBe("email");
  expect(categoryOf("reply_mail", "x")).toBe("email");
  expect(categoryOf("stripe_create_charge", "stripe")).toBe("purchase");
  expect(categoryOf("stripe_create_charge", "")).toBe("purchase");
  expect(categoryOf("checkout", "shop")).toBe("purchase");
  expect(categoryOf("refund_order", "x")).toBe("purchase");
  expect(categoryOf("create_customer", "paypal")).toBe("purchase");
});

test("categoryOf: reads and unrelated tools have no category", () => {
  expect(categoryOf("list_charges", "stripe")).toBeUndefined();
  expect(categoryOf("search_mail", "gmail")).toBeUndefined();
  expect(categoryOf("post_message", "slack")).toBeUndefined();
});

test("nameRisk: a read verb with a sensitive word is unknown", () => {
  for (const t of [
    "get_oauth_token",
    "read_secret",
    "fetch_credentials",
    "download_file",
    "export_data",
    "get_password",
    "getApiKey",
  ])
    expect(nameRisk(t)).toBe("unknown");
  // Only a whole token counts.
  expect(nameRisk("list_keyboards")).toBe("read");
});
