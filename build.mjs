// בונה את האתר לתיקייה dist:
// לוקח את התמונות שהועלו בפאנל, יוצר מכל אחת גרסאות AVIF ו-WebP בכמה גדלים,
// הופך כל GIF לסרטון MP4 קל שרץ בלופ, וכותב את רשימת העבודות והלוגואים לתוך index.html.
import sharp from "sharp";
import ffmpeg from "ffmpeg-static";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, cp, rm, access } from "node:fs/promises";
import path from "node:path";

const OUT = "dist";
const CACHE = ".cache/images";          // נשמר בין בניות כדי לא לעבד שוב תמונות קיימות
const WIDTHS = [480, 960, 1920];
const LOGO_H = 88;                      // פי 2 מגובה התצוגה, לחדות במסכי רטינה

const readJson = async (f, key) => {
  try { return JSON.parse(await readFile(f, "utf8"))[key] ?? []; } catch { return []; }
};
const exists = p => access(p).then(() => true, () => false);
const local = src => path.join(".", decodeURI(src).replace(/^\/+/, ""));
const hash = buf => createHash("sha1").update(buf).digest("hex").slice(0, 12);
const run = promisify(execFile);

// GIF ← MP4: בלי קול, רוחב עד 1280, רקע לבן מאחורי שקיפות (MP4 לא תומך בשקיפות)
const toMp4 = (src, out) => run(ffmpeg, ["-y", "-loglevel", "error", "-i", src, "-f", "lavfi", "-i", "color=c=white",
  "-filter_complex", "[1][0]scale2ref[bg][v];[bg][v]overlay=shortest=1,scale='trunc(min(1280,iw)/2)*2':-2:flags=lanczos,setsar=1,format=yuv420p",
  "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-movflags", "+faststart", out]);

await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}/images`, { recursive: true });
await mkdir(`${OUT}/logos`, { recursive: true });
await mkdir(CACHE, { recursive: true });

const thumbs = {};

// --- עבודות ---
const works = [];
for (const w of await readJson("data/works.json", "works")) {
  if (!w.image) continue;
  const file = local(w.image);
  if (!(await exists(file))) { console.warn("חסר קובץ:", file); continue; }
  const buf = await readFile(file);
  const id = hash(buf);
  const img = sharp(buf, { failOn: "none" }).rotate();
  const { width, height } = await img.metadata().then(m =>
    (m.orientation ?? 1) >= 5 ? { width: m.height, height: m.width } : m);

  for (const size of WIDTHS) {
    for (const fmt of ["avif", "webp"]) {
      if (fmt === "avif" && size === 1920) continue; // לתצוגה המוגדלת מספיק WebP
      const name = `${id}-${size}.${fmt}`;
      const cached = `${CACHE}/${name}`;
      if (!(await exists(cached))) {
        let p = img.clone().resize({ width: size, withoutEnlargement: true });
        p = fmt === "avif" ? p.avif({ quality: 55, effort: 4 }) : p.webp({ quality: 80 });
        await p.toFile(cached);
        console.log("נוצר", name);
      }
      await cp(cached, `${OUT}/images/${name}`);
    }
  }
  // GIF: התמונות שנוצרו למעלה (מהפריים הראשון) משמשות כתמונת פתיחה, והאנימציה עצמה עוברת ל-MP4
  const video = file.toLowerCase().endsWith(".gif");
  if (video) {
    const cached = `${CACHE}/${id}.mp4`;
    if (!(await exists(cached))) { await toMp4(file, cached); console.log("נוצר", `${id}.mp4`); }
    await cp(cached, `${OUT}/images/${id}.mp4`);
  }
  works.push({ id, w: width, h: height, alt: w.title || "עבודה של ציפי גרידינגר", ...(video && { v: 1 }) });
  thumbs[w.image] = `images/${id}-480.webp`;
}

// --- לוגואים ---
const logos = [];
for (const c of await readJson("data/clients.json", "clients")) {
  if (!c.logo) continue;
  const file = local(c.logo);
  if (!(await exists(file))) { console.warn("חסר קובץ:", file); continue; }
  const buf = await readFile(file);
  const id = hash(buf);
  if (file.toLowerCase().endsWith(".svg")) {
    await writeFile(`${OUT}/logos/${id}.svg`, buf);
    logos.push({ src: `logos/${id}.svg`, alt: c.name || "" });
    thumbs[c.logo] = `logos/${id}.svg`;
  } else {
    thumbs[c.logo] = `logos/${id}.webp`;
    await sharp(buf).resize({ height: LOGO_H, withoutEnlargement: true }).webp({ quality: 90 }).toFile(`${OUT}/logos/${id}.webp`);
    logos.push({ src: `logos/${id}.webp`, alt: c.name || "" });
  }
}

// --- index.html ---
const json = JSON.stringify({ works, logos }).replace(/</g, "\\u003c");
const html = (await readFile("src/index.html", "utf8"))
  .replace(/\/\*DATA\*\/[\s\S]*?\/\*END\*\//, json)
  .replace("<!--PREVIEW-CUT-->\n", "");
await writeFile(`${OUT}/index.html`, html);
await cp("admin", `${OUT}/admin`, { recursive: true });
// --- אייקונים, תמונת שיתוף, ומידע למנועי חיפוש ---
await cp("static", OUT, { recursive: true });
const first = (await readJson("data/works.json", "works")).find(w => w.image && local(w.image));
if (first && (await exists(local(first.image)))) {
  // התמונה שמופיעה כששולחים קישור לאתר בוואטסאפ, בפייסבוק וכו'
  await sharp(await readFile(local(first.image))).rotate().resize(1200, 630, { fit: "cover", position: "attention" }).jpeg({ quality: 82 }).toFile(`${OUT}/og.jpg`);
}
const today = new Date().toISOString().slice(0, 10);
await writeFile(`${OUT}/sitemap.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://zgstudio.co.il/</loc><lastmod>${today}</lastmod></url>
</urlset>
`);
await writeFile(`${OUT}/robots.txt`, `User-agent: *
Disallow: /admin/

Sitemap: https://zgstudio.co.il/sitemap.xml
`);

// מפה של תמונות ממוזערות לפאנל הניהול: נתיב הקובץ שהועלה ← התמונה הקטנה באתר
await writeFile(`${OUT}/admin/thumbs.json`, JSON.stringify(thumbs));

console.log(`האתר נבנה: ${works.length} עבודות, ${logos.length} לוגואים`);
