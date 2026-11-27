import { describe, expect, it } from "vitest";
import { isFixItCommand } from "@/lib/github/webhooks";

describe("isFixItCommand", () => {
  it.each(["fix it", "Fix It", "  fix   it  ", "@my-app fix it", "@MY-APP fix it\n"])(
    "acceptsTheCommandForm %j",
    (body) => expect(isFixItCommand(body, "my-app")).toBe(true)
  );

  it.each(["other-bot fix it", "please fix it", "fix it later", "@other-app fix it", "fixit", ""])(
    "rejectsNonCommand %j",
    (body) => expect(isFixItCommand(body, "my-app")).toBe(false)
  );

  it("treatsRegexCharactersInTheSlugLiterally", () => {
    expect(isFixItCommand("@a.b fix it", "a.b")).toBe(true);
    expect(isFixItCommand("@axb fix it", "a.b")).toBe(false);
  });
});

import { canCommandBot } from "@/lib/github/webhooks";

describe("canCommandBot", () => {
  it.each(["OWNER", "MEMBER", "COLLABORATOR"])("U-05 allows %s", (assoc) => {
    expect(canCommandBot(assoc)).toBe(true);
  });

  it.each(["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", "MANNEQUIN", undefined])(
    "U-05 denies %s who is not the PR author",
    (assoc) => {
      expect(canCommandBot(assoc)).toBe(false);
    }
  );

  it("U-05 doesNotTrustThePrAuthorWithoutWriteAccess", () => {
    // A fork PR's author must not be able to make the bot commit or spend credits.
    expect(canCommandBot("CONTRIBUTOR")).toBe(false);
  });
});

import { isDiveCommand } from "@/lib/github/webhooks";

describe("isDiveCommand", () => {
  it.each(["dive", "DIVE", "deep", "deep review", "Deep  Review", "@my-app dive", "@MY-APP deep", "  @my-app deep review \n"])(
    "DU-07 acceptsTheCommandForm %j",
    (body) => expect(isDiveCommand(body, "my-app")).toBe(true)
  );

  it.each(["please dive into this", "dive?", "deep dive", "@other-app dive", "@my-app dive now", "fix it", "lookout", ""])(
    "DU-07 rejectsNonCommand %j",
    (body) => expect(isDiveCommand(body, "my-app")).toBe(false)
  );
});

import { isRetryCommand } from "@/lib/github/webhooks";

describe("isRetryCommand", () => {
  it.each(["retry", "Retry", "retry review", "@my-app retry", "@MY-APP Retry Review", "  @my-app retry \n"])(
    "DU-16 acceptsTheCommandForm %j",
    (body) => expect(isRetryCommand(body, "my-app")).toBe(true)
  );

  it.each(["please retry", "retry?", "retry later", "@other-app retry", "dive", ""])(
    "DU-16 rejectsNonCommand %j",
    (body) => expect(isRetryCommand(body, "my-app")).toBe(false)
  );
});
