import { describe, expect, it } from "vitest";
import { checkMailbox } from "@/infrastructure/connectors/email/mailbox";
import { bearerJson, requestJson } from "@/infrastructure/connectors/http";
import { fakeFetch } from "../support/fetch";

const KEY = "re_the_workspace_secret_key_1234";

async function refusal(json: unknown, url = "https://api.example.test/v1") {
  const { fetch } = fakeFetch([{ match: "GET https://api.example.test", status: 401, json }]);
  return ((await requestJson(fetch, "Service", url, { headers: bearerJson(KEY) }).catch((error: Error) => error)) as Error).message;
}

describe("what a service says when it refuses", () => {
  it("keeps the words that say what to fix", async () => {
    expect(await refusal({ message: "Invalid OAuth access token." })).toMatch(/^Service a refusé les identifiants\s:\sInvalid OAuth access token\.$/);
  });

  it("never repeats the key it was sent", async () => {
    expect(await refusal({ message: `Invalid key ${KEY}` })).not.toContain(KEY);
  });

  it("never repeats a key from the address it was asked at", async () => {
    expect(await refusal({ message: "No such key abcdef123456" }, "https://api.example.test/v1?api_key=abcdef123456")).not.toContain("abcdef123456");
  });

  it("never repeats a key in an address, what follows a name for one, or a long token", async () => {
    const said = await refusal({ message: "Rejected https://api.example.test/x?api_key=abc123secret token=def456secret Bearer ghi789secret sk_live_jkl012secret 0123456789abcdef0123456789abcdef" });
    for (const secret of ["abc123secret", "def456secret", "ghi789secret", "jkl012secret", "0123456789abcdef0123456789abcdef"]) expect(said).not.toContain(secret);
  });

  it("stays short, whatever a service answers", async () => {
    expect((await refusal({ message: "mot ".repeat(500) })).length).toBeLessThan(300);
  });
});

describe("a mailbox's check that throws something else", () => {
  it("says it without the password in it", async () => {
    const check = await checkMailbox("IMAP", async () => {
      throw new Error("Command failed: LOGIN ada password=abc123secret");
    });
    expect(JSON.stringify(check)).not.toContain("abc123secret");
  });
});
