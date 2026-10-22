/**
 * Videos the TV can play: presets a parent picks with one tap, and lists of their own URLs.
 *
 * Only videos we may show with a blur on top: open-licensed films hosted on our own CloudFront
 * (`/media/…`, uploaded by scripts/upload-media.sh, served with CORS so the TV can check that the
 * picture is really drawn), and the 1-minute clip bundled in the APK. Streaming services (YouTube,
 * Netflix, …) are not supported: covering their player with our blur would break their terms.
 */

import { L } from "../firesense/i18n";
import { PlaylistItemSchema, PlaylistSchema, type Playlist, type PlaylistItem } from "../firesense";
import { WEB_ORIGIN } from "./config";

const media = (file: string) => `${WEB_ORIGIN}/media/${file}`;

// All AV1: on a real Fire TV, frames from the hardware decoder (H.264, VP9 of 360 lines or more) drawn
// into the page — which the blur needs — showed green stripes; AV1 is decoded in software there (dav1d),
// 720p without dropped frames even with the blur on. Encoded by scripts/upload-media.sh.
const item = (title: string, file: string, credit: string): PlaylistItem => ({ title, url: media(file), credit });
const BBB = item("Big Buck Bunny", "big-buck-bunny-720p-av1.mp4", "Big Buck Bunny © 2008 Blender Foundation / peach.blender.org (CC BY 3.0)");
const LLAMA_DRAMA = item("Caminandes: Llama Drama", "caminandes-1-llama-drama-720p-av1.mp4", "Caminandes: Llama Drama © 2013 Blender Foundation (CC BY 3.0)");
const GRAN_DILLAMA = item("Caminandes 2: Gran Dillama", "caminandes-2-gran-dillama-720p-av1.mp4", "Caminandes 2: Gran Dillama © 2013 Blender Foundation (CC BY 3.0)");
const LLAMIGOS = item("Caminandes 3: Llamigos", "caminandes-3-llamigos-720p-av1.mp4", "Caminandes 3: Llamigos © 2016 Blender Foundation (CC BY 3.0)");
const SPRING = item("Spring", "spring-720p-av1.mp4", "Spring © 2019 Blender Foundation (CC BY 4.0)");
const WING_IT = item("WING IT!", "wing-it-720p-av1.mp4", "WING IT! © 2023 Blender Foundation / studio.blender.org (CC BY 4.0)");
const COFFEE_RUN = item("Coffee Run", "coffee-run-720p-av1.mp4", "Coffee Run © 2020 Blender Foundation (CC BY 4.0)");
const DAILY_DWEEBS = item("The Daily Dweebs", "daily-dweebs-720p-av1.mp4", "The Daily Dweebs © 2017 Blender Foundation (CC BY 4.0)");
const GULLIVER = item("Gulliver's Travels (1939)", "gullivers-travels-1939-720p-av1.mp4", "Gulliver's Travels (1939, Fleischer Studios), public domain (Wikimedia Commons)");
const TO_SPRING = item("To Spring (1936)", "to-spring-1936-480p-av1.mp4", "To Spring (1936), public domain (Wikimedia Commons)");

const BUNDLED_URL = "/videos/cartoon-av1.mp4";

/** The 1-minute clip bundled in the APK. A function: titles follow the UI language, set after load. */
export function bundledClip(): PlaylistItem {
  return { title: L("Sample (1 minute of Big Buck Bunny)", "おためし（Big Buck Bunny の1分）"), url: BUNDLED_URL, credit: BBB.credit };
}

export interface PlaylistPreset extends Playlist {
  /** One line for the parent's button. */
  description: string;
}

/** Functions, not constants: titles follow the UI language, which is set after this module loads. */
export function playlistPresets(): PlaylistPreset[] {
  return [
    {
      id: "all-day",
      title: L("All day (10 films, about 2 hours)", "ずっと流す（全10本・約2時間）"),
      description: L("Open movies and public-domain classics on repeat, including the feature Gulliver's Travels", "オープンムービーとパブリックドメインの名作を順番にくり返し。長編「ガリバー旅行記」入り"),
      items: [BBB, LLAMA_DRAMA, GRAN_DILLAMA, LLAMIGOS, DAILY_DWEEBS, WING_IT, SPRING, COFFEE_RUN, TO_SPRING, GULLIVER],
    },
    {
      id: "open-movies",
      title: L("Animal shorts, 4 films (about 17 min)", "動物のアニメ 4本（約17分）"),
      description: L("Big Buck Bunny (a rabbit), then Caminandes 1–3 (a llama), on repeat. No dialogue", "Big Buck Bunny（ウサギ）→ Caminandes 1〜3（リャマ）をくり返し。セリフなし"),
      items: [BBB, LLAMA_DRAMA, GRAN_DILLAMA, LLAMIGOS],
    },
    {
      id: "gulliver",
      title: L("Gulliver's Travels (1939, about 76 min)", "ガリバー旅行記（1939年・約76分）"),
      description: L("Feature animation by the Fleischer brothers (English, public domain)", "フライシャー兄弟の長編アニメ（英語・パブリックドメイン）"),
      items: [GULLIVER],
    },
    { id: "big-buck-bunny", title: L("Big Buck Bunny (about 10 min)", "Big Buck Bunny（約10分）"), description: L("A rabbit in the forest (no dialogue)", "森のウサギのお話（セリフなし）"), items: [BBB] },
    { id: "caminandes", title: L("Caminandes 1–3 (about 7 min)", "Caminandes 1〜3（約7分）"), description: L("Three llama stories (no dialogue)", "リャマのお話 3本（セリフなし）"), items: [LLAMA_DRAMA, GRAN_DILLAMA, LLAMIGOS] },
    { id: "bundled", title: L("Sample (1 min, built into the TV)", "おためし（1分・TVに内蔵）"), description: L("A short clip that plays without a network", "ネットにつながらなくても流れる短い動画"), items: [bundledClip()] },
  ];
}

/** What the TV plays until a parent picks something. */
export function defaultPlaylist(): Playlist {
  return playlistPresets()[0];
}

const STREAMING = /(^|\.)(youtube\.com|youtu\.be|netflix\.com|primevideo\.com|amazon\.co\.jp|tver\.jp|abema\.tv|disneyplus\.com|hulu\.jp|nicovideo\.jp|tiktok\.com)$/i;

/** Most items in the family's own list. */
export const MAX_CUSTOM_ITEMS = 50;

/** Videos a parent can add with one tap (our AV1 mirrors, open-licensed, no dialogue). */
export function sampleItems(): (PlaylistItem & { note: string })[] {
  return [
    { ...LLAMIGOS, note: L("A llama and penguins, about 2.5 min", "リャマとペンギン・約2.5分") },
    { ...LLAMA_DRAMA, note: L("A llama, about 1.5 min", "リャマ・約1.5分") },
    { ...SPRING, note: L("A shepherd girl and her dog, about 7.5 min", "羊飼いの少女と犬・約7.5分") },
    { ...TO_SPRING, note: L("Gnomes who bring the spring, about 9 min, public domain", "春を呼ぶ小人たち・約9分・パブリックドメイン") },
    { ...WING_IT, note: L("A cat and a dog build a rocket, about 4 min", "ネコとイヌのロケットづくり・約4分") },
    { ...DAILY_DWEEBS, note: L("A mischievous puppy, about 1 min", "いたずら子犬・約1分") },
    { ...COFFEE_RUN, note: L("Coffee, then a run, about 3 min", "コーヒーを飲んで走る・約3分") },
    { ...GULLIVER, note: L("Feature animation, about 76 min, public domain", "長編アニメ・約76分・パブリックドメイン") },
  ];
}

/**
 * Earlier builds pointed at H.264 files and Wikimedia Commons VP9 sample URLs, which the Fire TV decodes
 * in hardware (green stripes). Lists saved on the TV or in DynamoDB still hold them: known old URLs are
 * mapped to the AV1 versions of the same films. Anything else is left as the parent entered it.
 */
const COMMONS_T = "https://upload.wikimedia.org/wikipedia/commons/transcoded/";
const LEGACY_URLS: Record<string, string> = {
  [media("big-buck-bunny-720p.mp4")]: BBB.url,
  [media("caminandes-2-gran-dillama-720p.mp4")]: GRAN_DILLAMA.url,
  "/videos/cartoon.mp4": BUNDLED_URL,
  [`${COMMONS_T}a/ab/Caminandes_3_-_Llamigos_-_Blender_Animated_Short.webm/Caminandes_3_-_Llamigos_-_Blender_Animated_Short.webm.480p.vp9.webm`]: LLAMIGOS.url,
  [`${COMMONS_T}d/d0/Caminandes-_Llama_Drama_-_Short_Movie.ogv/Caminandes-_Llama_Drama_-_Short_Movie.ogv.480p.vp9.webm`]: LLAMA_DRAMA.url,
  [`${COMMONS_T}a/a5/Spring_-_Blender_Open_Movie.webm/Spring_-_Blender_Open_Movie.webm.480p.vp9.webm`]: SPRING.url,
  [`${COMMONS_T}1/1d/To_Spring_%281936%29.webm/To_Spring_%281936%29.webm.480p.vp9.webm`]: TO_SPRING.url,
};

/** The list with known old URLs replaced by their AV1 versions (same object when nothing changed). */
export function upgradeLegacyUrls(p: Playlist): Playlist {
  if (!p.items.some((i) => LEGACY_URLS[i.url])) return p;
  return { ...p, items: p.items.map((i) => (LEGACY_URLS[i.url] ? { ...i, url: LEGACY_URLS[i.url] } : i)) };
}

/** One item a parent typed: https only, no streaming services. Throws with the reason. */
export function parsePlaylistItem(title: string, rawUrl: string): PlaylistItem {
  const url = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(L(`Not a valid URL (${url.slice(0, 80) || "empty"})`, `URL として読めません（${url.slice(0, 80) || "空"}）`));
  }
  if (parsed.protocol !== "https:") throw new Error(L("Only https:// URLs can be used", "https:// の URL だけ使えます"));
  if (STREAMING.test(parsed.hostname)) {
    throw new Error(L(`${parsed.hostname} cannot be used (streaming services' terms do not allow covering their video with a blur)`, `${parsed.hostname} は使えません（配信サービスの動画に、ぼかしを重ねることは規約で認められていません）`));
  }
  const file = decodeURIComponent(parsed.pathname.split("/").pop() ?? "") || parsed.hostname;
  return PlaylistItemSchema.parse({ title: (title.trim() || file).slice(0, 200), url });
}

/**
 * Before adding: can the TV fetch it? Asks for the first bytes the way the TV will (CORS, https).
 * Resolves with nothing, or throws with what is wrong. It does not decode the video: a format the TV
 * cannot play still shows up on the TV, with its error.
 */
export async function checkVideoUrl(url: string, timeoutMs = 10_000): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { headers: { Range: "bytes=0-1" }, mode: "cors", signal: ctrl.signal });
  } catch (err) {
    throw new Error(
      ctrl.signal.aborted
        ? L(`No response within ${timeoutMs / 1000} s`, `${timeoutMs / 1000}秒以内に応答がありませんでした`)
        : L(`Cannot load it (the host does not allow CORS, or cannot be reached: ${(err as Error).message})`, `読み込めません（配信元が CORS を許可していないか、つながりません: ${(err as Error).message}）`)
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(L(`The host returned ${res.status}`, `配信元が ${res.status} を返しました`));
  const type = res.headers.get("content-type") ?? "";
  if (!/^(video\/|application\/octet-stream)/i.test(type)) throw new Error(L(`Not a video (Content-Type: ${type || "none"})`, `動画ではありません（Content-Type: ${type || "なし"}）`));
}

/** The family's list with a new item at the end (a new list when there is none yet). */
export function withItem(list: Playlist | null, item: PlaylistItem): Playlist {
  const items = [...(list?.items ?? []), item];
  if (items.length > MAX_CUSTOM_ITEMS) throw new Error(L(`Up to ${MAX_CUSTOM_ITEMS} videos`, `動画は${MAX_CUSTOM_ITEMS}本までです`));
  return PlaylistSchema.parse({ id: "custom", title: list?.title ?? L("Our list", "うちのリスト"), items });
}
