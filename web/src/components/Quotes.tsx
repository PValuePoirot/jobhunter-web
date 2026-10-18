import { useCallback, useEffect, useState } from "react";
import proverbs from "../data/proverbs.json";

type Q = { text: string; origin: string; tag: string; meaning?: string };
const Q_LIST = proverbs as Q[];
const DUR = 14000;

export default function Quotes() {
  const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [i, setI] = useState(() => { try { return (+(localStorage.getItem("jh-q") || -1) + 1) % Q_LIST.length; } catch { return 0; } });
  const [paused, setPaused] = useState(reduce);
  const [hover, setHover] = useState(false);
  const [tick, setTick] = useState(0);
  const go = useCallback((d: number) => { setI(x => (x + d + Q_LIST.length) % Q_LIST.length); setTick(t => t + 1); }, []);

  useEffect(() => { try { localStorage.setItem("jh-q", String(i)); } catch { /* ignore */ } }, [i]);
  useEffect(() => {
    if (paused || hover) return;
    const t = setTimeout(() => go(1), DUR);
    return () => clearTimeout(t);
  }, [i, paused, hover, go, tick]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight"].includes(e.key) || e.altKey || e.metaKey || e.ctrlKey) return;
      const tag = (e.target as HTMLElement).tagName;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || (e.target as HTMLElement).isContentEditable) return;
      go(e.key === "ArrowRight" ? 1 : -1);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [go]);

  const q = Q_LIST[i];
  return (
    <section className="hero" aria-label="Motivational quote" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span className="petal p1" /><span className="petal p2" /><span className="petal p3" />
      <button className="qbtn" aria-label="Previous quote" onClick={() => go(-1)}>◀</button>
      <figure className="bubble flip" key={`${i}-${tick}`} aria-live="polite">
        <span className="tag">{q.tag}</span>
        <blockquote id="qText">{q.text}</blockquote>
        {q.meaning && <div id="qMeaning">{q.meaning}</div>}
        <figcaption className="qsrc">— {q.origin}</figcaption>
      </figure>
      <button className="qbtn" aria-label="Next quote" onClick={() => go(1)}>▶</button>
      <div className="qctl">
        <button className="qmini" aria-pressed={paused} onClick={() => setPaused(p => !p)}>{paused ? "▶ play" : "⏸ pause"}</button>
        <div className={`qbar run ${paused || hover ? "paused" : ""}`} key={`b${i}-${tick}`} style={{ ["--dur" as string]: `${DUR}ms` }}><i /></div>
        <span className="qcount">{String(i + 1).padStart(2, "0")} / {Q_LIST.length}</span>
      </div>
    </section>
  );
}
