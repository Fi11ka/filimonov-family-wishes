// Gift photos are large, so lists come without them and each card asks for its
// own. A photo is fetched once per version of the gift (updated_at changes with
// every edit, in the app and in the bot), and at most eight at a time: about
// as many cards as a laptop screen shows.
import { api } from "./api";

const MAX_AT_ONCE = 8;
const photos = new Map<string, Promise<string>>();
let running = 0;
const waiting: (() => void)[] = [];

function queued<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running++;
      job()
        .then(resolve, reject)
        .finally(() => {
          running--;
          waiting.shift()?.();
        });
    };
    if (running < MAX_AT_ONCE) start();
    else waiting.push(start);
  });
}

/**
 * The photo of a gift: a data URL, or a shop link the bot saved. `urgent` skips
 * the queue for a photo the person asked for (the wish form).
 */
export function giftPhoto(
  id: string,
  version: number | undefined,
  urgent = false,
): Promise<string> {
  const key = `${id}:${version ?? ""}`;
  let p = photos.get(key);
  if (!p) {
    const load = () =>
      api<{ photo: string }>(`/api/gifts/${id}/photo`).then((r) => r.photo);
    p = urgent ? load() : queued(load);
    // A failed load is not remembered: the next view tries again.
    p.catch(() => photos.delete(key));
    photos.set(key, p);
  }
  return p;
}

/** After the wish form saves: the next view of this gift fetches its photo again. */
export function forgetGiftPhoto(id: string) {
  for (const key of photos.keys())
    if (key.startsWith(`${id}:`)) photos.delete(key);
}
