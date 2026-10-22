import { afterEach, describe, expect, test } from "vitest";
import { L, lang, setLang, speechLang } from "../lib/firesense/i18n";
import { STATE_LABEL } from "../lib/client/labels";
import { MODE_LABEL } from "../lib/client/mode";

describe("UI language", () => {
  afterEach(() => setLang("en"));

  test("English is the default; Japanese only when set", () => {
    expect(lang()).toBe("en");
    expect(L("Too close", "近すぎ")).toBe("Too close");
    expect(speechLang()).toBe("en-US");
    setLang("ja");
    expect(L("Too close", "近すぎ")).toBe("近すぎ");
    expect(speechLang()).toBe("ja-JP");
  });

  test("labels built when their module loads still follow a later language change", () => {
    expect(STATE_LABEL.TOO_CLOSE.text).toBe("Too close");
    expect(MODE_LABEL.shadow.title).toBe("Record only");
    setLang("ja");
    expect(STATE_LABEL.TOO_CLOSE.text).toBe("近すぎ");
    expect(MODE_LABEL.shadow.title).toBe("記録のみ（シャドー）");
  });
});
