import { describe, expect, test } from "vitest";

process.env.NEXT_PUBLIC_WS_URL ??= "wss://relay.example/prod";
process.env.NEXT_PUBLIC_API_URL ??= "https://api.example";
process.env.NEXT_PUBLIC_WEB_ORIGIN ??= "https://web.example";
const { defaultPlaylist, MAX_CUSTOM_ITEMS, playlistPresets, sampleItems, parsePlaylistItem, upgradeLegacyUrls, withItem } = await import("../lib/client/playlists");
const { PlaylistSchema } = await import("../lib/firesense");

describe("playlists", () => {
  test("every preset is a valid playlist with credits, served from our own origin or the APK", () => {
    for (const p of playlistPresets()) {
      expect(PlaylistSchema.safeParse(p).success).toBe(true);
      for (const item of p.items) {
        expect(item.url.startsWith("https://web.example/media/") || item.url.startsWith("/videos/")).toBe(true);
        expect(item.credit).toMatch(/CC BY|public domain/);
        expect(item.url).toMatch(/-av1\.mp4$/);
      }
    }
    expect(defaultPlaylist().items.length).toBeGreaterThan(1);
  });

  test("one item: title optional, https only, streaming services refused", () => {
    expect(parsePlaylistItem("", "https://a.example/v/one.mp4")).toEqual({ title: "one.mp4", url: "https://a.example/v/one.mp4" });
    expect(parsePlaylistItem("おさんぽ", " https://b.example/walk.webm ")).toEqual({ title: "おさんぽ", url: "https://b.example/walk.webm" });
    expect(() => parsePlaylistItem("", "https://www.youtube.com/watch?v=x")).toThrow(/www\.youtube\.com cannot be used/);
    expect(() => parsePlaylistItem("", "http://a.example/v.mp4")).toThrow(/Only https:\/\/ URLs/);
    expect(() => parsePlaylistItem("", "not a url")).toThrow(/Not a valid URL/);
  });

  test("the family's list grows one item at a time, up to the limit", () => {
    const item = { title: "A", url: "https://a.example/a.mp4" };
    const one = withItem(null, item);
    expect(one).toMatchObject({ id: "custom", items: [item] });
    expect(withItem(one, { ...item, title: "B" }).items.map((i) => i.title)).toEqual(["A", "B"]);
    let big = one;
    for (let i = 1; i < MAX_CUSTOM_ITEMS; i++) big = withItem(big, item);
    expect(() => withItem(big, item)).toThrow(/Up to 50 videos/);
  });

  test("samples are our AV1 mirrors with a license in the credit", () => {
    for (const s of sampleItems()) {
      expect(s.url).toMatch(/^https:\/\/web\.example\/media\/.+-av1\.mp4$/);
      expect(s.credit).toMatch(/CC BY|public domain/);
    }
  });

  test("old saved URLs (H.264 presets, Commons VP9 samples) become their AV1 versions; others stay", () => {
    const old = {
      id: "custom",
      title: "うちのリスト",
      items: [
        { title: "BBB", url: "https://web.example/media/big-buck-bunny-720p.mp4" },
        { title: "Llamigos", url: "https://upload.wikimedia.org/wikipedia/commons/transcoded/a/ab/Caminandes_3_-_Llamigos_-_Blender_Animated_Short.webm/Caminandes_3_-_Llamigos_-_Blender_Animated_Short.webm.480p.vp9.webm" },
        { title: "mine", url: "https://a.example/mine.mp4" },
      ],
    };
    const up = upgradeLegacyUrls(old);
    expect(up.items.map((i) => i.url)).toEqual(["https://web.example/media/big-buck-bunny-720p-av1.mp4", "https://web.example/media/caminandes-3-llamigos-720p-av1.mp4", "https://a.example/mine.mp4"]);
    expect(upgradeLegacyUrls(up)).toBe(up);
  });
});
